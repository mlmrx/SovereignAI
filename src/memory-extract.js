import { getProvider } from './providers/index.js';

/**
 * Auto memory extraction (opt-in): after a chat exchange, ask the model to
 * distill durable facts about the user and store them as memory notes.
 * Fire-and-forget — failures are silent, chat latency is never affected.
 */
export async function autoExtractMemories({
  store,
  config,
  providerId = config.defaults.provider,
  model,
  userMessage,
  assistantReply,
  conversationId = null,
}) {
  const provider = getProvider(providerId);
  const cfg = config.providers[providerId];
  if (!provider.isConfigured(cfg)) return;

  const existing = store.listMemories().slice(-30).map((m) => `- ${m.content}`).join('\n').slice(0, 3000) || '(none)';
  const system =
    'You maintain the long-term memory of a personal AI. From the exchange, extract at most 3 NEW durable facts ' +
    'worth remembering about the user: stable preferences, identity, projects, decisions, or corrections. ' +
    'Ignore small talk, one-off questions, and anything already known. ' +
    'Output one fact per line, each starting with "- ". If there is nothing durable, output exactly: NONE';
  const prompt =
    `Already known:\n${existing}\n\nExchange:\nUser: ${userMessage.slice(0, 2000)}\n` +
    `Assistant: ${assistantReply.slice(0, 1500)}\n\nNew durable facts:`;

  let out = '';
  const stream = provider.chatStream({
    cfg,
    model: model || (providerId === config.defaults.provider ? config.defaults.model : undefined),
    system,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 1024,
  });
  for await (const part of stream) {
    if (part.type === 'delta') out += part.text;
  }

  const facts = parseFactLines(out, 3);
  const known = new Set(store.listMemories().map((m) => m.content.toLowerCase()));
  for (const fact of facts) {
    if (!known.has(fact.toLowerCase())) {
      store.addMemory(fact, { origin: 'extracted', sourceConversationId: conversationId });
    }
  }
}

/**
 * Distill durable memories out of one whole (typically imported) conversation.
 * Unlike autoExtractMemories this is a deliberate foreground operation
 * ("sovereign distill" / import-chat --distill): errors propagate to the
 * caller so a CLI run can report exactly which conversation failed instead of
 * silently marking it done. Returns the facts that were actually added.
 */
export async function distillConversationMemories({
  store,
  config,
  providerId = config.defaults.provider,
  model,
  conversation,
  messages,
}) {
  const provider = getProvider(providerId);
  const cfg = config.providers[providerId];
  if (!provider.isConfigured(cfg)) {
    throw new Error(`Provider "${providerId}" is not configured; configure it in Settings or pass a different provider`);
  }

  const transcript = boundedTranscript(messages);
  if (!transcript) return [];

  const existing = store.listMemories().slice(-40).map((m) => `- ${m.content}`).join('\n').slice(0, 4000) || '(none)';
  const system =
    'You maintain the long-term memory of a personal AI. The user imported this conversation from another AI platform. ' +
    'Extract at most 5 NEW durable facts about the user worth remembering permanently: stable preferences, identity, ' +
    'projects, decisions, or corrections. Ignore small talk, one-off questions, assistant knowledge, and anything ' +
    'already known. Output one fact per line, each starting with "- ". If there is nothing durable, output exactly: NONE';
  const prompt = `Already known:\n${existing}\n\nImported conversation${conversation.title ? ` "${conversation.title.slice(0, 200)}"` : ''}:\n${transcript}\n\nNew durable facts:`;

  let out = '';
  const stream = provider.chatStream({
    cfg,
    model: model || (providerId === config.defaults.provider ? config.defaults.model : undefined),
    system,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 1024,
  });
  for await (const part of stream) {
    if (part.type === 'delta') out += part.text;
  }

  const facts = parseFactLines(out, 5);
  const known = new Set(store.listMemories().map((m) => m.content.toLowerCase()));
  const added = [];
  for (const fact of facts) {
    if (known.has(fact.toLowerCase())) continue;
    store.addMemory(fact, { origin: 'distilled', sourceConversationId: conversation.id });
    known.add(fact.toLowerCase());
    added.push(fact);
  }
  return added;
}

/** tolerate model quirks: "- fact" / "• fact" / "* fact" lines, stray NONE entries */
function parseFactLines(text, max) {
  return [...text.matchAll(/^\s*[-•*]\s+(.{8,300})$/gm)]
    .map((m) => m[1].trim())
    .filter((f) => !/^NONE\b/i.test(f))
    .slice(0, max);
}

/**
 * A conversation can be arbitrarily long; keep the prompt bounded by taking
 * the head and tail (where identity and conclusions usually live) and noting
 * the elision instead of pretending the middle was read.
 */
function boundedTranscript(messages, { maxChars = 9000 } = {}) {
  const lines = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 1200)}`);
  if (!lines.length) return '';
  const head = [];
  const tail = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length > maxChars * 0.6) break;
    head.push(line);
    used += line.length + 1;
  }
  for (let i = lines.length - 1; i > head.length - 1; i--) {
    const line = lines[i];
    if (used + line.length > maxChars) break;
    tail.unshift(line);
    used += line.length + 1;
  }
  const omitted = lines.length - head.length - tail.length;
  return [...head, ...(omitted > 0 ? [`[... ${omitted} messages omitted ...]`] : []), ...tail].join('\n');
}
