import { getProvider, isLocalProviderEndpoint, providerEndpointHost } from './providers/index.js';
import { retrieve, formatContext } from './rag/retriever.js';
import { autoExtractMemories, extractionTarget } from './memory-extract.js';
import { HttpError } from './util.js';

/**
 * Assemble one chat turn without touching the database: resolve the persona
 * and model, load and trim the prior turns, place memory notes and knowledge
 * excerpts into the system prompt, and return the exact array that would be
 * handed to `provider.chatStream`. Side-effect-free by contract — this is what
 * `POST /api/chat/preview` shows before a remote send (ADR-26) and what
 * `handleChat` streams from, so the declaration and the request cannot drift
 * apart. Retrieval runs (it is a read); nothing is created or written.
 */
export async function assembleChatRequest({ store, config, conversationId, personaId, message }) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) throw new HttpError(400, 'message is required');
  if (text.length > 200_000) throw new HttpError(413, 'message must be at most 200,000 characters');

  const persona = resolvePersona(store, personaId, config);
  const { provider, providerCfg, model } = resolveModel(config, persona);

  const conversation = conversationId ? store.getConversation(conversationId) : null;
  if (conversationId && !conversation) throw new HttpError(404, 'Conversation not found');

  // History is the transcript as stored before this turn is persisted.
  const history = trimHistory(conversation ? store.listMessages(conversation.id) : [], config.limits.historyChars);
  const { system, sources, memories } = await buildSystemPrompt({ store, config, persona, query: text });

  return {
    persona,
    conversation,
    provider,
    providerCfg,
    model,
    local: isLocalProviderEndpoint(provider.id, providerCfg),
    endpointHost: providerEndpointHost(providerCfg),
    system,
    memories,
    sources,
    history,
    message: text,
    // The exact array handed to provider.chatStream.
    messages: [...history, { role: 'user', content: text }],
    temperature: provider.id === 'anthropic' ? undefined : persona.temperature,
  };
}

/**
 * The context as it crosses the wire: the system prompt as a leading
 * system-role message when present, then the trimmed history, then the new
 * user turn — the `messages` array an OpenAI-compatible or Ollama endpoint
 * receives verbatim (Anthropic carries the same content as `system` +
 * `messages`). "bytes" everywhere in the product means the UTF-8 length of
 * this array serialized as JSON.
 */
export function outgoingContext(request) {
  return [...(request.system ? [{ role: 'system', content: request.system }] : []), ...request.messages];
}

/** Sizes of what leaves: characters of content, bytes on the wire, a rough token count, message count. */
export function outgoingTotals(request) {
  const context = outgoingContext(request);
  const chars = context.reduce((sum, part) => sum + part.content.length, 0);
  return {
    chars,
    bytes: Buffer.byteLength(JSON.stringify(context), 'utf8'),
    approxTokens: Math.ceil(chars / 4),
    messages: context.length,
  };
}

/**
 * The customs declaration (ADR-26): everything that would leave for this turn,
 * with sizes, and nothing else — no API key, no endpoint URL (host only), and
 * no write of any kind. Same body and validation as `handleChat`.
 */
export async function previewChatRequest({ store, config, body }) {
  const request = await assembleChatRequest({
    store,
    config,
    conversationId: body.conversationId,
    personaId: body.personaId,
    message: body.message,
  });
  const { provider, persona } = request;
  let extraction = null;
  if (config.memory?.autoExtract && persona.use_memory) {
    const target = extractionTarget(config, { providerId: provider.id, model: request.model });
    if (target) extraction = { provider: target.providerId, model: target.model ?? null, local: target.local };
  }
  return {
    provider: { id: provider.id, label: provider.label, local: request.local, host: request.endpointHost },
    model: request.model,
    parts: {
      system: request.system,
      memories: request.memories.map((m) => ({ id: m.id, content: m.content })),
      sources: request.sources.map((s) => ({
        documentId: s.documentId,
        title: s.document,
        excerpt: s.content,
        score: s.score,
        method: s.method,
      })),
      history: request.history,
      message: request.message,
    },
    totals: outgoingTotals(request),
    extraction,
  };
}

/**
 * Orchestrate one chat turn:
 * assemble context (persona + history + memory + knowledge) → stream the
 * model's reply over SSE → persist both sides of the exchange locally.
 */
export async function handleChat({ store, config, body, sse, signal }) {
  const request = await assembleChatRequest({
    store,
    config,
    conversationId: body.conversationId,
    personaId: body.personaId,
    message: body.message,
  });
  const { persona, provider, providerCfg, model, system, message } = request;
  // The stream's meta carries excerpts of what was placed in the prompt; the
  // full text is the preview's business (ADR-26).
  const sources = request.sources.map(({ content, ...source }) => source);
  const memories = request.memories.map(({ content, ...memory }) => memory);

  const conversation =
    request.conversation ?? store.createConversation({ persona_id: persona.id, title: message.slice(0, 64) });
  store.addMessage({ conversation_id: conversation.id, role: 'user', content: message });

  // Weight provenance: resolve which exact weights will answer, in parallel
  // with the stream. Ollama exposes a digest; other providers don't — NULL
  // then, reported as unknown rather than guessed.
  let modelDigest = null;
  const digestPromise = resolveModelDigest(provider, providerCfg, model)
    .then((digest) => (modelDigest = digest))
    .catch(() => null);

  sse.send('meta', {
    conversationId: conversation.id,
    conversationTitle: conversation.title,
    persona: persona.name,
    provider: provider.id,
    model,
    sources,
    memories,
    // The receipt (ADR-26): how much left and for which host — null when the
    // provider is local and nothing left the machine.
    outgoing: request.local ? null : { ...outgoingTotalsForReceipt(request), host: request.endpointHost },
  });

  let text = '';
  // Reasoning ("thinking") deltas are relayed to the client as they stream and
  // then dropped: they are never appended to `text`, never stored, and never fed
  // to memory extraction. Only the character count survives, so the UI can say
  // honestly that reasoning was shown but not kept.
  let reasoningChars = 0;
  let usage = {};
  let stopReason = 'end_turn';
  try {
    const stream = provider.chatStream({
      cfg: providerCfg,
      model,
      system,
      messages: request.messages,
      temperature: request.temperature,
      maxTokens: config.limits.maxTokens,
      signal,
    });
    for await (const part of stream) {
      if (part.type === 'delta') {
        text += part.text;
        sse.send('delta', { text: part.text });
      } else if (part.type === 'reasoning') {
        reasoningChars += part.text.length;
        sse.send('reasoning', { text: part.text });
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

  await digestPromise; // resolved or null by now; never throws
  const saved = persistAssistant();
  sse.send('done', {
    conversationId: conversation.id,
    messageId: saved?.id ?? null,
    usage,
    stopReason,
    modelDigest,
    reasoningChars,
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
      model_digest: modelDigest,
      tokens_in: usage.input_tokens ?? null,
      tokens_out: usage.output_tokens ?? null,
    });
    store.touchConversation(conversation.id);
    return saved;
  }
}

// The receipt carries the sizes, not the message count (that is the preview's).
function outgoingTotalsForReceipt(request) {
  const { chars, bytes, approxTokens } = outgoingTotals(request);
  return { bytes, chars, approxTokens };
}

// One digest lookup per (endpoint, model) per minute — never blocks the
// stream, never fails the chat, returns null when the provider has no
// notion of a weight digest.
const digestCache = new Map();
const DIGEST_TTL_MS = 60_000;
async function resolveModelDigest(provider, cfg, model) {
  if (provider.id !== 'ollama' || !model) return null;
  const key = `${cfg?.baseUrl ?? ''}\0${model}`;
  const cached = digestCache.get(key);
  if (cached && Date.now() - cached.at < DIGEST_TTL_MS) return cached.digest;
  const models = await provider.listModels(cfg);
  const digest = models.find((m) => m.id === model)?.digest ?? null;
  digestCache.set(key, { digest, at: Date.now() });
  return digest;
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
      // were actually placed in the prompt for this turn. The stream carries
      // the excerpt; the outgoing preview shows the whole note (`content`).
      memories = selected.map((m) => ({ id: m.id, excerpt: String(m.content).slice(0, 300), content: String(m.content) }));
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
        // The whole excerpt as placed in the prompt (the stream carries only `excerpt`).
        content: r.content,
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
