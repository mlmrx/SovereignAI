/**
 * Dispatcher for chat-history import: accepts either a platform's export ZIP
 * (ChatGPT and Claude both email a ZIP containing a `conversations.json`)
 * or a bare JSON file, extracts the conversation JSON, and hands it to the
 * right parser — explicitly chosen, or auto-detected from the JSON's shape.
 *
 * Reuses the existing zero-dep ZIP reader from src/ingest/zip.js (already
 * shipped for DOCX) rather than adding new unzip logic.
 */

import { readZipEntries } from '../ingest/zip.js';
import { ChatImportError } from './shared.js';
import * as chatgpt from './chatgpt.js';
import * as claude from './claude.js';
import * as gemini from './gemini.js';
import * as generic from './generic.js';

export { ChatImportError } from './shared.js';

// Order matters for auto-detection: more specific/structural checks first,
// generic last since its `detect` is the most permissive.
const PARSERS = { chatgpt, claude, gemini, generic };
const DETECT_ORDER = ['chatgpt', 'claude', 'gemini', 'generic'];

// The filename both ChatGPT's and Claude's export ZIPs use for the
// conversation payload.
const ZIP_CANDIDATE_NAME = 'conversations.json';

export function supportedPlatforms() {
  return Object.keys(PARSERS);
}

/**
 * @param {Buffer} buffer - the uploaded/CLI-supplied file, ZIP or JSON
 * @param {{ platform?: string }} options - force a specific parser instead of auto-detecting
 */
export function parseChatExport(buffer, { platform } = {}) {
  if (platform && !PARSERS[platform]) {
    throw new ChatImportError(`Unknown platform "${platform}". Supported: ${supportedPlatforms().join(', ')}`);
  }

  const { json, sourceNote } = extractJson(buffer);
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ChatImportError(`Could not parse ${sourceNote} as JSON`);
  }

  const platformId = platform ?? detectPlatform(parsed);
  if (!platformId) {
    throw new ChatImportError(
      `Could not recognize this file's format. Pass --from <platform> explicitly, or reshape it to the generic import format (see docs/CHAT_IMPORT.md).`
    );
  }
  const result = PARSERS[platformId].parse(parsed);
  return { platform: platformId, conversations: result.conversations, warnings: result.warnings };
}

/**
 * Parse a chat export and write it into the store, skipping any
 * conversation already imported (same source_platform + externalId) so
 * re-running an import — the same file, or an updated export covering
 * overlapping history — is safe rather than duplicating everything.
 */
export function importChatExport(store, buffer, { platform, personaId = null } = {}) {
  const { platform: detected, conversations, warnings } = parseChatExport(buffer, { platform });
  let imported = 0;
  let skipped = 0;
  for (const convo of conversations) {
    if (store.findConversationByExternalId(detected, convo.externalId)) {
      skipped++;
      continue;
    }
    const record = store.importConversation({
      persona_id: personaId,
      title: convo.title,
      external_id: convo.externalId,
      source_platform: detected,
      created_at: convo.createdAt,
      updated_at: convo.updatedAt,
    });
    for (const message of convo.messages) {
      store.importMessage({ conversation_id: record.id, role: message.role, content: message.content, created_at: message.createdAt });
    }
    imported++;
  }
  return { platform: detected, imported, skipped, totalParsed: conversations.length, warnings };
}

function detectPlatform(parsed) {
  for (const id of DETECT_ORDER) {
    if (PARSERS[id].detect(parsed)) return id;
  }
  return null;
}

function extractJson(buffer) {
  let entries;
  try {
    entries = readZipEntries(buffer);
  } catch {
    entries = null; // not a ZIP (or corrupt) — fall through to treating it as raw JSON
  }
  if (entries) {
    if (!entries.names.includes(ZIP_CANDIDATE_NAME)) {
      throw new ChatImportError(
        `This ZIP does not contain a ${ZIP_CANDIDATE_NAME} (found: ${entries.names.slice(0, 10).join(', ') || 'no files'}). Is this the right export file?`
      );
    }
    return { json: entries.read(ZIP_CANDIDATE_NAME).toString('utf8'), sourceNote: `${ZIP_CANDIDATE_NAME} inside the ZIP` };
  }
  return { json: buffer.toString('utf8'), sourceNote: 'the file' };
}
