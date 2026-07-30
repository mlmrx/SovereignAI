/**
 * Parser for Anthropic's Claude data export (Settings → Privacy → Export
 * data), specifically the `conversations.json` file inside the emailed ZIP.
 * Structurally simpler than ChatGPT's: a flat, linear `chat_messages` array
 * per conversation rather than a branching tree, since Claude's web/app UI
 * doesn't expose response regeneration as separate branches the same way.
 *
 * Anthropic's export has carried message text in two shapes across format
 * revisions — a flat `text` field, and a `content` array of blocks matching
 * the Messages API shape (`[{type:'text', text:'...'}]`, potentially mixed
 * with tool-use/tool-result blocks for newer exports with tool-enabled
 * conversations). This reads `content` blocks first and falls back to
 * `text`, so it tolerates either without needing to know which export
 * generation produced the file.
 */

import { ChatImportError, MAX_CONVERSATIONS, finalizeConversation, toIso } from './shared.js';

export function detect(parsed) {
  return Array.isArray(parsed) && parsed.some((c) => c && typeof c === 'object' && Array.isArray(c.chat_messages));
}

export function parse(parsed) {
  if (!Array.isArray(parsed)) throw new ChatImportError('Expected the Claude export\'s conversations.json to be a JSON array');
  const warnings = [];
  const conversations = [];

  for (const [index, raw] of parsed.slice(0, MAX_CONVERSATIONS).entries()) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.chat_messages)) {
      warnings.push(`Skipped conversation #${index + 1}: missing "chat_messages"`);
      continue;
    }
    try {
      const messages = raw.chat_messages
        .map((m) => normalizeMessage(m))
        .filter((m) => m && m.content);
      if (!messages.length) {
        warnings.push(`Skipped "${raw.name || 'Untitled'}": no importable messages found`);
        continue;
      }
      conversations.push(
        finalizeConversation({
          externalId: raw.uuid ?? `claude-${index}`,
          title: raw.name,
          createdAt: toIso(raw.created_at),
          updatedAt: toIso(raw.updated_at),
          messages,
        })
      );
    } catch (err) {
      warnings.push(`Skipped "${raw.name || `conversation #${index + 1}`}": ${err.message}`);
    }
  }
  if (parsed.length > MAX_CONVERSATIONS) {
    warnings.push(`Export contains more than ${MAX_CONVERSATIONS} conversations; only the first ${MAX_CONVERSATIONS} were read`);
  }
  return { conversations, warnings };
}

function normalizeMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const role = message.sender === 'human' ? 'user' : message.sender === 'assistant' ? 'assistant' : null;
  if (!role) return null;

  let text = '';
  if (Array.isArray(message.content)) {
    text = message.content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join('\n\n');
  }
  if (!text && typeof message.text === 'string') text = message.text.trim();
  if (!text) return null;

  return { role, content: text, createdAt: toIso(message.created_at) };
}
