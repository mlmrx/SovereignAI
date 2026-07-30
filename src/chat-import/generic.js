/**
 * Universal fallback importer: a documented, flexible JSON shape for any
 * platform without a dedicated parser above (Grok, Kimi, GLM, DeepSeek,
 * Qwen, and anything else — including tools not invented yet). Rather than
 * guess at the export schema of platforms this had no reliable way to
 * verify against, this accepts a simple shape a user (or a script, or an
 * LLM asked to reformat an export) can produce for *any* source:
 *
 *   [
 *     {
 *       "title": "optional",
 *       "externalId": "optional, enables idempotent re-import",
 *       "createdAt": "optional ISO 8601 or Unix timestamp",
 *       "updatedAt": "optional",
 *       "messages": [
 *         { "role": "user" | "assistant" | "system", "content": "...", "createdAt": "optional" }
 *       ]
 *     }
 *   ]
 *
 * A bare `{ "conversations": [...] }` wrapper (SovereignAI's own export
 * shape for this feature) is also accepted. This is intentionally the least
 * clever parser in this directory — no format-specific guessing, just
 * validation of a shape that's documented and stable because we define it.
 */

import { ChatImportError, MAX_CONVERSATIONS, finalizeConversation, toIso } from './shared.js';

export function detect(parsed) {
  const list = extractList(parsed);
  return Array.isArray(list) && list.length > 0 && list.every((c) => c && typeof c === 'object' && Array.isArray(c.messages));
}

export function parse(parsed) {
  const list = extractList(parsed);
  if (!Array.isArray(list)) {
    throw new ChatImportError(
      'Expected a JSON array of conversations (or {"conversations":[...]}), each with a "messages" array of {role, content}. See docs/CHAT_IMPORT.md for the exact shape.'
    );
  }
  const warnings = [];
  const conversations = [];

  for (const [index, raw] of list.slice(0, MAX_CONVERSATIONS).entries()) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.messages)) {
      warnings.push(`Skipped entry #${index + 1}: missing a "messages" array`);
      continue;
    }
    const messages = raw.messages
      .map((m) => normalizeMessage(m))
      .filter((m) => m && m.content);
    if (!messages.length) {
      warnings.push(`Skipped "${raw.title || `entry #${index + 1}`}": no messages with a role and non-empty content`);
      continue;
    }
    conversations.push(
      finalizeConversation({
        externalId: raw.externalId ?? raw.external_id ?? raw.id ?? `generic-${index}`,
        title: raw.title,
        createdAt: toIso(raw.createdAt ?? raw.created_at),
        updatedAt: toIso(raw.updatedAt ?? raw.updated_at),
        messages,
      })
    );
  }
  if (list.length > MAX_CONVERSATIONS) {
    warnings.push(`Input contains more than ${MAX_CONVERSATIONS} conversations; only the first ${MAX_CONVERSATIONS} were read`);
  }
  return { conversations, warnings };
}

function extractList(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.conversations)) return parsed.conversations;
  return null;
}

function normalizeMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const role = ['user', 'assistant', 'system'].includes(message.role) ? message.role : null;
  if (!role) return null;
  const content = typeof message.content === 'string' ? message.content.trim() : '';
  if (!content) return null;
  return { role, content, createdAt: toIso(message.createdAt ?? message.created_at) };
}
