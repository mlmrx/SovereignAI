/**
 * Best-effort parser for Google Takeout's "My Activity" export (Gemini/Bard
 * Apps activity, JSON format), covering Gemini imports.
 *
 * ============================================================================
 * EXPERIMENTAL — lower confidence than chatgpt.js/claude.js. Those two are
 * official, documented, stable conversation exports; Takeout's "My Activity"
 * is an activity LOG, not a conversation export, and its exact shape for
 * Gemini specifically was not something this could be verified against (no
 * Google account export available while building this, unlike the ChatGPT/
 * Claude formats which are well-established public knowledge). What's known
 * with reasonable confidence: Takeout activity records are JSON objects with
 * `title`, `time`, and a `header`/`products` field naming the source product.
 * What's NOT confidently known: whether Gemini activity records reliably
 * include the model's response anywhere in structured form, or only the
 * user's prompt. This parser assumes the latter (prompt-only) and imports
 * each activity as a single-message note rather than guessing at a response
 * field that may not exist — check the warnings this returns, and treat the
 * result as a starting point to verify, not a faithful transcript.
 * ============================================================================
 */

import { ChatImportError, MAX_CONVERSATIONS, finalizeConversation, toIso } from './shared.js';

const PROMPT_PREFIXES = [/^asked gemini:\s*/i, /^prompted gemini( apps)?( with)?:\s*/i, /^asked bard:\s*/i, /^you asked:\s*/i];

export function detect(parsed) {
  if (!Array.isArray(parsed)) return false;
  return parsed.some((entry) => isGeminiActivityEntry(entry));
}

export function parse(parsed) {
  if (!Array.isArray(parsed)) throw new ChatImportError('Expected a Google Takeout activity export to be a JSON array');
  const warnings = [
    'Gemini import is experimental: Google Takeout\'s activity export was not verified against a live account while this was built. Each entry below is imported as a single prompt with no model response, since Takeout activity records do not reliably capture one in structured form. Verify the results before relying on them.',
  ];
  const conversations = [];
  let skippedNonGemini = 0;

  const entries = parsed.slice(0, MAX_CONVERSATIONS);
  for (const [index, raw] of entries.entries()) {
    if (!isGeminiActivityEntry(raw)) {
      skippedNonGemini++;
      continue;
    }
    const prompt = extractPrompt(raw.title);
    if (!prompt) {
      warnings.push(`Skipped activity entry #${index + 1}: could not extract prompt text from "${String(raw.title ?? '').slice(0, 80)}"`);
      continue;
    }
    const createdAt = toIso(raw.time);
    conversations.push(
      finalizeConversation({
        externalId: raw.header && raw.time ? `${raw.time}` : `gemini-${index}`,
        title: prompt.slice(0, 80),
        createdAt,
        updatedAt: createdAt,
        messages: [{ role: 'user', content: prompt, createdAt }],
      })
    );
  }
  if (skippedNonGemini) {
    warnings.push(`Ignored ${skippedNonGemini} activity ${skippedNonGemini === 1 ? 'entry' : 'entries'} not attributed to Gemini/Bard.`);
  }
  if (parsed.length > MAX_CONVERSATIONS) {
    warnings.push(`Export contains more than ${MAX_CONVERSATIONS} activity entries; only the first ${MAX_CONVERSATIONS} were read`);
  }
  return { conversations, warnings };
}

function isGeminiActivityEntry(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.title !== 'string') return false;
  const products = Array.isArray(entry.products) ? entry.products.join(' ') : '';
  const haystack = `${entry.header ?? ''} ${products}`.toLowerCase();
  return haystack.includes('gemini') || haystack.includes('bard');
}

function extractPrompt(title) {
  if (typeof title !== 'string') return '';
  let text = title.trim();
  for (const prefix of PROMPT_PREFIXES) text = text.replace(prefix, '');
  return text.trim();
}
