import { getProvider } from './providers/index.js';
import { retrieve, formatContext } from './rag/retriever.js';
import { autoExtractMemories } from './memory-extract.js';
import { HttpError } from './util.js';

/**
 * Orchestrate one chat turn:
 * resolve persona → assemble context (history + memory + knowledge) → stream
 * the model's reply over SSE → persist both sides of the exchange locally.
 */
export async function handleChat({ store, config, body, sse, signal }) {
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) throw new HttpError(400, 'message is required');

  const persona = resolvePersona(store, body.personaId, config);
  const { provider, providerCfg, model } = resolveModel(config, persona);

  let conversation = body.conversationId ? store.getConversation(body.conversationId) : null;
  if (body.conversationId && !conversation) throw new HttpError(404, 'Conversation not found');
  if (!conversation) {
    conversation = store.createConversation({ persona_id: persona.id, title: message.slice(0, 64) });
  }

  // History is assembled before persisting the new user turn.
  const history = trimHistory(store.listMessages(conversation.id), config.limits.historyChars);
  store.addMessage({ conversation_id: conversation.id, role: 'user', content: message });

  const { system, sources } = await buildSystemPrompt({ store, config, persona, query: message });

  sse.send('meta', {
    conversationId: conversation.id,
    conversationTitle: conversation.title,
    persona: persona.name,
    provider: provider.id,
    model,
    sources,
  });

  let text = '';
  let usage = {};
  let stopReason = 'end_turn';
  try {
    const stream = provider.chatStream({
      cfg: providerCfg,
      model,
      system,
      messages: [...history, { role: 'user', content: message }],
      temperature: provider.id === 'anthropic' ? undefined : persona.temperature,
      maxTokens: config.limits.maxTokens,
      signal,
    });
    for await (const part of stream) {
      if (part.type === 'delta') {
        text += part.text;
        sse.send('delta', { text: part.text });
      } else if (part.type === 'done') {
        usage = part.usage ?? {};
        stopReason = part.stopReason ?? 'end_turn';
      }
    }
  } catch (err) {
    if (signal?.aborted) {
      // client went away mid-stream — keep whatever was generated
      persistAssistant();
      return;
    }
    if (text) sse.send('delta', { text: `\n\n⚠️ Stream interrupted: ${err.message}` });
    persistAssistant(err.message);
    sse.send('error', { message: err.message });
    sse.end();
    return;
  }

  if (!text && stopReason === 'refusal') {
    text = 'The model declined this request for safety reasons.';
    sse.send('delta', { text });
  }

  const saved = persistAssistant();
  sse.send('done', {
    conversationId: conversation.id,
    messageId: saved?.id ?? null,
    usage,
    stopReason,
  });
  sse.end();

  if (config.memory?.autoExtract && text && persona.use_memory) {
    autoExtractMemories({ store, config, userMessage: message, assistantReply: text }).catch(() => {});
  }

  function persistAssistant(errorNote) {
    const content = text || (errorNote ? `⚠️ ${errorNote}` : '');
    if (!content) return null;
    const saved = store.addMessage({
      conversation_id: conversation.id,
      role: 'assistant',
      content,
      provider: provider.id,
      model,
      tokens_in: usage.input_tokens ?? null,
      tokens_out: usage.output_tokens ?? null,
    });
    store.touchConversation(conversation.id);
    return saved;
  }
}

function resolvePersona(store, personaId, config) {
  if (personaId) {
    const persona = store.getPersona(personaId);
    if (!persona) throw new HttpError(404, 'Persona not found');
    return persona;
  }
  if (config?.defaults?.personaId) {
    const persona = store.getPersona(config.defaults.personaId);
    if (persona) return persona;
  }
  const first = store.listPersonas()[0];
  if (!first) throw new HttpError(400, 'No personas exist — create one first');
  return first;
}

function resolveModel(config, persona) {
  const providerId = persona.provider || config.defaults.provider;
  const provider = getProvider(providerId);
  const providerCfg = config.providers[providerId];
  if (!provider.isConfigured(providerCfg)) {
    throw new HttpError(400, `Provider "${providerId}" is not configured — open Settings to set it up`);
  }
  const model = persona.model || config.defaults.model;
  if (!model && providerId !== 'anthropic') {
    throw new HttpError(400, 'No model selected — pick a default model in Settings');
  }
  return { provider, providerCfg, model };
}

/** Keep the most recent turns within the character budget. */
export function trimHistory(messages, maxChars) {
  const out = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    total += m.content.length;
    if (total > maxChars && out.length > 0) break;
    out.unshift({ role: m.role, content: m.content });
  }
  // providers require the transcript to start with a user turn
  while (out.length > 0 && out[0].role !== 'user') out.shift();
  return out;
}

async function buildSystemPrompt({ store, config, persona, query }) {
  const parts = [persona.system_prompt];
  let sources = [];

  if (persona.use_memory) {
    const memories = store.listMemories();
    if (memories.length > 0) {
      parts.push('Long-term notes the user asked you to remember:\n' + memories.map((m) => `- ${m.content}`).join('\n'));
    }
  }

  if (persona.use_knowledge) {
    const results = await retrieve({ store, config, query });
    if (results.length > 0) {
      parts.push(formatContext(results));
      sources = results.map((r) => ({ document: r.document, score: r.score, method: r.method }));
    }
  }

  return { system: parts.join('\n\n---\n\n'), sources };
}
