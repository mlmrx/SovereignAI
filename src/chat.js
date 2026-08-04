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
  if (message.length > 200_000) throw new HttpError(413, 'message must be at most 200,000 characters');

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

  const { system, sources, memories } = await buildSystemPrompt({ store, config, persona, query: message });

  sse.send('meta', {
    conversationId: conversation.id,
    conversationTitle: conversation.title,
    persona: persona.name,
    provider: provider.id,
    model,
    sources,
    memories,
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
    autoExtractMemories({
      store,
      config,
      providerId: provider.id,
      model,
      userMessage: message,
      assistantReply: text,
      conversationId: conversation.id,
    }).catch(() => {});
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
  // A workspace default model only belongs to its default provider. Reusing an
  // Ollama model name for an Anthropic/OpenAI persona (or vice versa) produces
  // a confusing upstream error; provider overrides must name their own model.
  const model = persona.model || (providerId === config.defaults.provider ? config.defaults.model : '');
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
    const remaining = Math.max(0, maxChars - total);
    if (remaining === 0) break;
    const content = m.content.length > remaining ? m.content.slice(-remaining) : m.content;
    out.unshift({ role: m.role, content });
    total += content.length;
    if (content.length < m.content.length) break;
  }
  // providers require the transcript to start with a user turn
  while (out.length > 0 && out[0].role !== 'user') out.shift();
  return out;
}

async function buildSystemPrompt({ store, config, persona, query }) {
  const parts = [persona.system_prompt];
  let sources = [];
  let memories = [];

  if (persona.use_memory) {
    const selected = selectMemories(store.listRecentMemories?.(1000) ?? store.listMemories(), query);
    if (selected.length > 0) {
      parts.push('Relevant long-term notes the user asked you to remember:\n' + selected.map((m) => `- ${m.content}`).join('\n'));
      // Reported to clients so recall can be shown truthfully: these notes
      // were actually placed in the prompt for this turn.
      memories = selected.map((m) => ({ id: m.id, excerpt: String(m.content).slice(0, 300) }));
    }
  }

  if (persona.use_knowledge) {
    const results = await retrieve({ store, config, query });
    if (results.length > 0) {
      parts.push(formatContext(results));
      sources = results.map((r) => ({
        id: r.id,
        chunkId: r.id,
        documentId: r.documentId,
        document: r.document,
        excerpt: r.content.slice(0, 600),
        score: r.score,
        method: r.method,
      }));
    }
  }

  return { system: parts.join('\n\n---\n\n'), sources, memories };
}

/** Rank memory notes by query overlap, then recency, within a hard prompt budget. */
export function selectMemories(
  memories,
  query,
  { maxChars = 6000, maxItems = 24, maxTerms = 128, maxCandidates = 1000 } = {}
) {
  // Both chat input and imported memory can be large. Retrieval must stay
  // predictably bounded because it runs on the single Node event loop before
  // provider streaming begins.
  const terms = new Set();
  for (const match of String(query).toLowerCase().matchAll(/[\p{L}\p{N}_-]{3,}/gu)) {
    terms.add(match[0]);
    if (terms.size >= maxTerms) break;
  }
  const firstCandidate = Math.max(0, memories.length - maxCandidates);
  const candidates = memories.slice(firstCandidate);
  const ranked = candidates.map((memory, candidateIndex) => {
    const content = String(memory.content ?? '').slice(0, Math.max(maxChars, 2000));
    const lower = content.toLowerCase();
    let score = 0;
    for (const term of terms) if (lower.includes(term)) score++;
    return { memory, index: firstCandidate + candidateIndex, score, content };
  });
  ranked.sort((a, b) => b.score - a.score || b.index - a.index);

  const selected = [];
  let used = 0;
  for (const entry of ranked) {
    if (!entry.content || selected.length >= maxItems) continue;
    const remaining = maxChars - used;
    if (remaining <= 0) break;
    const content = entry.content.slice(0, remaining);
    selected.push({ ...entry.memory, content });
    used += content.length + 2;
  }
  return selected;
}
