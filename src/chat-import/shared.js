/**
 * Common shape every platform parser (chatgpt.js, claude.js, gemini.js,
 * generic.js) reduces its export into, before it ever reaches the database:
 *
 *   { conversations: ImportedConversation[], warnings: string[] }
 *   ImportedConversation = {
 *     externalId: string,               // stable id for idempotent re-import
 *     title: string,
 *     createdAt: string | null,          // ISO 8601
 *     updatedAt: string | null,          // ISO 8601
 *     messages: { role: 'user'|'assistant'|'system', content: string, createdAt: string|null }[],
 *   }
 *
 * Parsers never touch the database directly — src/chat-import/index.js
 * hands their output to db.js's importConversation/importMessage. This
 * keeps every parser a pure function you can unit test with a JSON fixture
 * and no store/fs involved.
 */

export const MAX_CONVERSATIONS = 20_000;
export const MAX_MESSAGES_PER_CONVERSATION = 20_000;
export const MAX_MESSAGE_CHARS = 2_000_000; // generous: a few hundred pages of text
export const MAX_TITLE_CHARS = 10_000;

export class ChatImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChatImportError';
  }
}

/**
 * Normalize a timestamp to ISO 8601, or null if unusable. Accepts whatever
 * shape a given platform export uses: ChatGPT's Unix seconds (numeric,
 * fractional), Claude's already-ISO date strings, or a numeric string of
 * either. Tried as a date string first so an ISO string is never mangled by
 * `Number(...)` turning into NaN.
 */
export function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && /\d{4}-\d{2}-\d{2}/.test(value)) {
    const direct = new Date(value);
    if (!Number.isNaN(direct.getTime())) return direct.toISOString();
  }
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return null;
  // Heuristic: anything below this is almost certainly seconds, not ms (ms would be the year ~2001+).
  const ms = num < 10_000_000_000 ? num * 1000 : num;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function truncate(text, max) {
  const value = String(text ?? '');
  return value.length > max ? value.slice(0, max) : value;
}

/** Bounds-check and lightly sanitize one already-mapped conversation before it leaves a parser. */
export function finalizeConversation({ externalId, title, createdAt, updatedAt, messages }) {
  const bounded = messages.slice(0, MAX_MESSAGES_PER_CONVERSATION).map((m) => ({
    role: ['user', 'assistant', 'system'].includes(m.role) ? m.role : 'user',
    content: truncate(m.content, MAX_MESSAGE_CHARS),
    createdAt: m.createdAt ?? null,
  }));
  return {
    externalId: String(externalId),
    title: truncate(title || 'Imported conversation', MAX_TITLE_CHARS),
    createdAt: createdAt ?? null,
    updatedAt: updatedAt ?? createdAt ?? null,
    messages: bounded,
  };
}

export function joinTextParts(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((part) => typeof part === 'string')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n');
}
