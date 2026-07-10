import { getProvider } from './providers/index.js';

/**
 * Auto memory extraction (opt-in): after a chat exchange, ask the model to
 * distill durable facts about the user and store them as memory notes.
 * Fire-and-forget — failures are silent, chat latency is never affected.
 */
export async function autoExtractMemories({ store, config, userMessage, assistantReply }) {
  const providerId = config.defaults.provider;
  const provider = getProvider(providerId);
  const cfg = config.providers[providerId];
  if (!provider.isConfigured(cfg)) return;

  const existing = store.listMemories().map((m) => `- ${m.content}`).join('\n') || '(none)';
  const system =
    'You maintain the long-term memory of a personal AI. From the exchange, extract at most 3 NEW durable facts ' +
    'worth remembering about the user: stable preferences, identity, projects, decisions, or corrections. ' +
    'Ignore small talk, one-off questions, and anything already known. ' +
    'Output one fact per line, each starting with "- ". If there is nothing durable, output exactly: NONE';
  const prompt =
    `Already known:\n${existing.slice(0, 3000)}\n\nExchange:\nUser: ${userMessage.slice(0, 2000)}\n` +
    `Assistant: ${assistantReply.slice(0, 1500)}\n\nNew durable facts:`;

  let out = '';
  const stream = provider.chatStream({
    cfg,
    model: config.defaults.model,
    system,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 1024,
  });
  for await (const part of stream) {
    if (part.type === 'delta') out += part.text;
  }

  // tolerate model quirks: "- fact" / "• fact" / "* fact" lines, stray NONE entries
  const facts = [...out.matchAll(/^\s*[-•*]\s+(.{8,300})$/gm)]
    .map((m) => m[1].trim())
    .filter((f) => !/^NONE\b/i.test(f))
    .slice(0, 3);
  const known = new Set(store.listMemories().map((m) => m.content.toLowerCase()));
  for (const fact of facts) {
    if (!known.has(fact.toLowerCase())) store.addMemory(fact);
  }
}
