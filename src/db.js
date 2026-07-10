import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { newId, now } from './util.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  system_prompt TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  temperature REAL,
  use_memory INTEGER NOT NULL DEFAULT 1,
  use_knowledge INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  persona_id TEXT,
  title TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  embedded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding TEXT
);
CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id, idx);
`;

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  tightenPermissions(dataDir, 0o700);
  const dbFile = path.join(dataDir, 'sovereign.db');
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA busy_timeout = 5000;');
  // Keep enforcement enabled for compatible/future schemas. The current
  // tables predate FK clauses, so Store methods still own manual cascades.
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  for (const file of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
    if (fs.existsSync(file)) tightenPermissions(file, 0o600);
  }
  return new Store(db);
}

function tightenPermissions(target, mode) {
  try {
    fs.chmodSync(target, mode);
  } catch (err) {
    if (err.code !== 'EPERM' && err.code !== 'ENOSYS') throw err;
  }
}

export class Store {
  constructor(db) {
    this.db = db;
    this.knowledgeRevision = 0;
  }

  getCounts() {
    const row = this.db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM personas) AS personas,
          (SELECT COUNT(*) FROM conversations) AS conversations,
          (SELECT COUNT(*) FROM documents) AS documents,
          (SELECT COUNT(*) FROM memories) AS memories`
      )
      .get();
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
  }

  isEmptyExceptPersonas() {
    const row = this.db.prepare(
      `SELECT
        (SELECT COUNT(*) FROM conversations) +
        (SELECT COUNT(*) FROM messages) +
        (SELECT COUNT(*) FROM memories) +
        (SELECT COUNT(*) FROM documents) +
        (SELECT COUNT(*) FROM chunks) AS count`
    ).get();
    return Number(row.count) === 0;
  }

  getKnowledgeVersion() {
    const external = Number(this.db.prepare('PRAGMA data_version').get().data_version);
    return `${this.knowledgeRevision}:${external}`;
  }

  // ---- Personas ----
  listPersonas() {
    return this.db.prepare('SELECT * FROM personas ORDER BY created_at').all();
  }

  getPersona(id) {
    return this.db.prepare('SELECT * FROM personas WHERE id = ?').get(id);
  }

  createPersona(p) {
    const row = {
      id: p.id ?? newId(),
      name: p.name,
      description: p.description ?? '',
      system_prompt: p.system_prompt,
      provider: p.provider ?? null,
      model: p.model ?? null,
      temperature: p.temperature ?? null,
      use_memory: p.use_memory ? 1 : 0,
      use_knowledge: p.use_knowledge ? 1 : 0,
      created_at: now(),
      updated_at: now(),
    };
    this.db
      .prepare(
        `INSERT INTO personas (id, name, description, system_prompt, provider, model, temperature, use_memory, use_knowledge, created_at, updated_at)
         VALUES (:id, :name, :description, :system_prompt, :provider, :model, :temperature, :use_memory, :use_knowledge, :created_at, :updated_at)`
      )
      .run(row);
    return this.getPersona(row.id);
  }

  updatePersona(id, p) {
    const existing = this.getPersona(id);
    if (!existing) return null;
    const row = {
      id,
      name: p.name ?? existing.name,
      description: p.description ?? existing.description,
      system_prompt: p.system_prompt ?? existing.system_prompt,
      provider: p.provider !== undefined ? p.provider : existing.provider,
      model: p.model !== undefined ? p.model : existing.model,
      temperature: p.temperature !== undefined ? p.temperature : existing.temperature,
      use_memory: p.use_memory !== undefined ? (p.use_memory ? 1 : 0) : existing.use_memory,
      use_knowledge: p.use_knowledge !== undefined ? (p.use_knowledge ? 1 : 0) : existing.use_knowledge,
      updated_at: now(),
    };
    this.db
      .prepare(
        `UPDATE personas SET name=:name, description=:description, system_prompt=:system_prompt, provider=:provider,
         model=:model, temperature=:temperature, use_memory=:use_memory, use_knowledge=:use_knowledge, updated_at=:updated_at
         WHERE id=:id`
      )
      .run(row);
    return this.getPersona(id);
  }

  deletePersona(id) {
    return atomic(this.db, () => {
      this.db.prepare('UPDATE conversations SET persona_id = NULL WHERE persona_id = ?').run(id);
      return this.db.prepare('DELETE FROM personas WHERE id = ?').run(id);
    });
  }

  // ---- Conversations ----
  listConversations() {
    return this.db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all();
  }

  getConversation(id) {
    return this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  }

  createConversation({ persona_id, title = '' }) {
    const row = { id: newId(), persona_id: persona_id ?? null, title, created_at: now(), updated_at: now() };
    this.db
      .prepare('INSERT INTO conversations (id, persona_id, title, created_at, updated_at) VALUES (:id, :persona_id, :title, :created_at, :updated_at)')
      .run(row);
    return this.getConversation(row.id);
  }

  touchConversation(id, title) {
    if (title !== undefined) {
      this.db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, now(), id);
    } else {
      this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now(), id);
    }
  }

  renameConversation(id, title) {
    const result = this.db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, now(), id);
    return result.changes ? this.getConversation(id) : null;
  }

  deleteConversation(id) {
    return atomic(this.db, () => {
      this.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
      return this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    });
  }

  // ---- Messages ----
  listMessages(conversationId) {
    return this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid').all(conversationId);
  }

  addMessage(m) {
    const row = {
      id: m.id ?? newId(),
      conversation_id: m.conversation_id,
      role: m.role,
      content: m.content,
      provider: m.provider ?? null,
      model: m.model ?? null,
      tokens_in: m.tokens_in ?? null,
      tokens_out: m.tokens_out ?? null,
      created_at: now(),
    };
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, provider, model, tokens_in, tokens_out, created_at)
         VALUES (:id, :conversation_id, :role, :content, :provider, :model, :tokens_in, :tokens_out, :created_at)`
      )
      .run(row);
    return row;
  }

  // ---- Memories (long-term notes) ----
  listMemories() {
    return this.db.prepare('SELECT * FROM memories ORDER BY created_at').all();
  }

  listRecentMemories(limit = 1000) {
    const bounded = Math.max(1, Math.min(10_000, Number(limit) || 1000));
    return this.db
      .prepare('SELECT * FROM memories ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(bounded)
      .reverse();
  }

  addMemory(content) {
    const row = { id: newId(), content, created_at: now() };
    this.db.prepare('INSERT INTO memories (id, content, created_at) VALUES (:id, :content, :created_at)').run(row);
    return row;
  }

  updateMemory(id, content) {
    const result = this.db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(content, id);
    return result.changes ? this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) : null;
  }

  deleteMemory(id) {
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  }

  // ---- Documents & chunks (knowledge base) ----
  listDocuments() {
    return this.db.prepare('SELECT * FROM documents ORDER BY created_at DESC').all();
  }

  addDocument({ name, size, chunks, embedded }) {
    const doc = { id: newId(), name, size, chunk_count: chunks.length, embedded: embedded ? 1 : 0, created_at: now() };
    const result = atomic(this.db, () => {
      this.db
        .prepare('INSERT INTO documents (id, name, size, chunk_count, embedded, created_at) VALUES (:id, :name, :size, :chunk_count, :embedded, :created_at)')
        .run(doc);
      const insert = this.db.prepare('INSERT INTO chunks (id, document_id, idx, content, embedding) VALUES (?, ?, ?, ?, ?)');
      for (let i = 0; i < chunks.length; i++) {
        insert.run(newId(), doc.id, i, chunks[i].content, chunks[i].embedding ? JSON.stringify(chunks[i].embedding) : null);
      }
      return doc;
    });
    this.knowledgeRevision++;
    return result;
  }

  deleteDocument(id) {
    const result = atomic(this.db, () => {
      this.db.prepare('DELETE FROM chunks WHERE document_id = ?').run(id);
      return this.db.prepare('DELETE FROM documents WHERE id = ?').run(id);
    });
    if (result.changes) this.knowledgeRevision++;
    return result;
  }

  listAllChunks() {
    return this.db
      .prepare(
        `SELECT chunks.id, chunks.document_id, chunks.idx, chunks.content, chunks.embedding, documents.name AS document_name
         FROM chunks JOIN documents ON documents.id = chunks.document_id`
      )
      .all();
  }

  // ---- Export / import (data portability) ----
  exportAll() {
    return {
      personas: this.listPersonas(),
      conversations: this.listConversations(),
      messages: this.db.prepare('SELECT * FROM messages ORDER BY created_at, rowid').all(),
      memories: this.listMemories(),
      documents: this.listDocuments(),
      chunks: this.db.prepare('SELECT * FROM chunks').all(),
    };
  }

  importAll(data, { replacePersonas = false } = {}) {
    const tables = {
      personas: 'INSERT OR REPLACE INTO personas (id, name, description, system_prompt, provider, model, temperature, use_memory, use_knowledge, created_at, updated_at) VALUES (:id, :name, :description, :system_prompt, :provider, :model, :temperature, :use_memory, :use_knowledge, :created_at, :updated_at)',
      conversations: 'INSERT OR REPLACE INTO conversations (id, persona_id, title, created_at, updated_at) VALUES (:id, :persona_id, :title, :created_at, :updated_at)',
      messages: 'INSERT OR REPLACE INTO messages (id, conversation_id, role, content, provider, model, tokens_in, tokens_out, created_at) VALUES (:id, :conversation_id, :role, :content, :provider, :model, :tokens_in, :tokens_out, :created_at)',
      memories: 'INSERT OR REPLACE INTO memories (id, content, created_at) VALUES (:id, :content, :created_at)',
      documents: 'INSERT OR REPLACE INTO documents (id, name, size, chunk_count, embedded, created_at) VALUES (:id, :name, :size, :chunk_count, :embedded, :created_at)',
      chunks: 'INSERT OR REPLACE INTO chunks (id, document_id, idx, content, embedding) VALUES (:id, :document_id, :idx, :content, :embedding)',
    };
    const counts = atomic(this.db, () => {
      // createApp seeds three starter personas before a restore request can be
      // received. A verified-pristine caller may replace only those bootstrap
      // rows so a fresh restore does not duplicate every default persona.
      if (replacePersonas) this.db.prepare('DELETE FROM personas').run();
      // Validate the entire payload before the first INSERT while holding one
      // transaction snapshot, so relationship checks cannot race the writes.
      const validated = validateImport(data, this.db);
      const counts = {};
      for (const [table, sql] of Object.entries(tables)) {
        const rows = validated[table];
        if (!rows) continue;
        const stmt = this.db.prepare(sql);
        for (const row of rows) stmt.run(row);
        counts[table] = rows.length;
      }
      return counts;
    });
    if ((counts.documents ?? 0) > 0 || (counts.chunks ?? 0) > 0) this.knowledgeRevision++;
    return counts;
  }

  close() {
    this.db.close();
  }
}

export class ImportValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImportValidationError';
  }
}

let savepointSequence = 0;

/** A savepoint is atomic and remains safe when a caller already owns a transaction. */
function atomic(db, action) {
  const savepoint = `sovereign_store_${++savepointSequence}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = action();
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (err) {
    try {
      db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    } catch {
      // Preserve the original failure; the connection may itself have failed.
    }
    try {
      db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } catch {
      // Preserve the original failure.
    }
    throw err;
  }
}

const IMPORT_NORMALIZERS = {
  personas: normalizePersona,
  conversations: normalizeConversation,
  messages: normalizeMessage,
  memories: normalizeMemory,
  documents: normalizeDocument,
  chunks: normalizeChunk,
};

function validateImport(data, db) {
  if (!isObject(data)) throw new ImportValidationError('Import data must be an object');
  const validated = {};
  for (const [table, normalize] of Object.entries(IMPORT_NORMALIZERS)) {
    if (data[table] === undefined) continue;
    if (!Array.isArray(data[table])) throw new ImportValidationError(`Import field "${table}" must be an array`);
    const ids = new Set();
    validated[table] = data[table].map((row, index) => {
      try {
        if (!isObject(row)) throw new Error('row must be an object');
        const normalized = normalize(row);
        if (ids.has(normalized.id)) throw new Error(`duplicate id "${normalized.id}"`);
        ids.add(normalized.id);
        return normalized;
      } catch (err) {
        throw new ImportValidationError(`Invalid ${table}[${index}]: ${err.message}`);
      }
    });
  }
  validateImportRelationships(validated, db);
  return validated;
}

function validateImportRelationships(data, db) {
  const importedPersonas = new Set((data.personas ?? []).map((row) => row.id));
  const importedConversations = new Set((data.conversations ?? []).map((row) => row.id));
  const importedDocuments = new Set((data.documents ?? []).map((row) => row.id));
  const personaExists = db.prepare('SELECT 1 AS found FROM personas WHERE id = ?');
  const conversationExists = db.prepare('SELECT 1 AS found FROM conversations WHERE id = ?');
  const documentExists = db.prepare('SELECT 1 AS found FROM documents WHERE id = ?');
  const chunkAtPosition = db.prepare('SELECT id FROM chunks WHERE document_id = ? AND idx = ? LIMIT 1');

  // Older databases could retain conversations after their persona was
  // deleted. Preserve those exports without recreating a dangling reference.
  for (const conversation of data.conversations ?? []) {
    if (
      conversation.persona_id &&
      !importedPersonas.has(conversation.persona_id) &&
      !personaExists.get(conversation.persona_id)
    ) {
      conversation.persona_id = null;
    }
  }

  for (const [index, message] of (data.messages ?? []).entries()) {
    if (!importedConversations.has(message.conversation_id) && !conversationExists.get(message.conversation_id)) {
      throw new ImportValidationError(`Invalid messages[${index}]: conversation_id does not reference an imported or existing conversation`);
    }
  }

  const chunkPositions = new Set();
  for (const [index, chunk] of (data.chunks ?? []).entries()) {
    if (!importedDocuments.has(chunk.document_id) && !documentExists.get(chunk.document_id)) {
      throw new ImportValidationError(`Invalid chunks[${index}]: document_id does not reference an imported or existing document`);
    }
    const position = `${chunk.document_id}\0${chunk.idx}`;
    if (chunkPositions.has(position)) {
      throw new ImportValidationError(`Invalid chunks[${index}]: duplicate idx ${chunk.idx} for document ${chunk.document_id}`);
    }
    const existing = chunkAtPosition.get(chunk.document_id, chunk.idx);
    if (existing && existing.id !== chunk.id) {
      throw new ImportValidationError(`Invalid chunks[${index}]: document already has a different chunk at idx ${chunk.idx}`);
    }
    chunkPositions.add(position);
  }

  if (data.documents && data.chunks) {
    const chunksPerDocument = new Map();
    for (const chunk of data.chunks) {
      chunksPerDocument.set(chunk.document_id, (chunksPerDocument.get(chunk.document_id) ?? 0) + 1);
    }
    for (const [index, document] of data.documents.entries()) {
      const actual = chunksPerDocument.get(document.id) ?? 0;
      if (document.chunk_count !== actual) {
        throw new ImportValidationError(
          `Invalid documents[${index}]: chunk_count is ${document.chunk_count}, but import contains ${actual} chunks`
        );
      }
    }
  }
}

function normalizePersona(row) {
  return {
    id: requiredId(row.id, 'id'),
    name: requiredText(row.name, 'name', 4096),
    description: optionalNullableText(row.description, '', 'description', 1024 * 1024),
    system_prompt: requiredText(row.system_prompt, 'system_prompt', 20 * 1024 * 1024),
    provider: nullableText(row.provider, 'provider', 2048),
    model: nullableText(row.model, 'model', 2048),
    temperature: nullableNumber(row.temperature, 'temperature'),
    use_memory: binaryFlag(row.use_memory, 'use_memory', 1),
    use_knowledge: binaryFlag(row.use_knowledge, 'use_knowledge', 0),
    created_at: timestamp(row.created_at, 'created_at'),
    updated_at: timestamp(row.updated_at, 'updated_at'),
  };
}

function normalizeConversation(row) {
  return {
    id: requiredId(row.id, 'id'),
    persona_id: nullableText(row.persona_id, 'persona_id', 512),
    title: optionalNullableText(row.title, '', 'title', 10000),
    created_at: timestamp(row.created_at, 'created_at'),
    updated_at: timestamp(row.updated_at, 'updated_at'),
  };
}

function normalizeMessage(row) {
  const role = requiredText(row.role, 'role', 32);
  if (!['user', 'assistant', 'system'].includes(role)) throw new Error('role must be user, assistant, or system');
  return {
    id: requiredId(row.id, 'id'),
    conversation_id: requiredId(row.conversation_id, 'conversation_id'),
    role,
    content: text(row.content, 'content', 20 * 1024 * 1024),
    provider: nullableText(row.provider, 'provider', 2048),
    model: nullableText(row.model, 'model', 2048),
    tokens_in: nullableInteger(row.tokens_in, 'tokens_in', 0),
    tokens_out: nullableInteger(row.tokens_out, 'tokens_out', 0),
    created_at: timestamp(row.created_at, 'created_at'),
  };
}

function normalizeMemory(row) {
  return {
    id: requiredId(row.id, 'id'),
    content: requiredText(row.content, 'content', 20 * 1024 * 1024),
    created_at: timestamp(row.created_at, 'created_at'),
  };
}

function normalizeDocument(row) {
  return {
    id: requiredId(row.id, 'id'),
    name: requiredText(row.name, 'name', 4096),
    size: integer(row.size, 'size', 0),
    chunk_count: integer(row.chunk_count, 'chunk_count', 0),
    embedded: binaryFlag(row.embedded, 'embedded', 0),
    created_at: timestamp(row.created_at, 'created_at'),
  };
}

function normalizeChunk(row) {
  return {
    id: requiredId(row.id, 'id'),
    document_id: requiredId(row.document_id, 'document_id'),
    idx: integer(row.idx, 'idx', 0),
    content: text(row.content, 'content', 20 * 1024 * 1024),
    embedding: normalizeEmbedding(row.embedding),
  };
}

function requiredId(value, label) {
  return requiredText(value, label, 512);
}

function requiredText(value, label, max) {
  const valueAsText = text(value, label, max);
  if (!valueAsText.trim()) throw new Error(`${label} must not be empty`);
  return valueAsText;
}

function text(value, label, max) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  if (value.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return value;
}

function optionalNullableText(value, fallback, label, max) {
  if (value === undefined) return fallback;
  return value === null ? null : text(value, label, max);
}

function nullableText(value, label, max) {
  return value === undefined || value === null ? null : text(value, label, max);
}

function timestamp(value, label) {
  return value === undefined ? now() : requiredText(value, label, 128);
}

function integer(value, label, min) {
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${label} must be a safe integer of at least ${min}`);
  return value;
}

function nullableInteger(value, label, min) {
  return value === undefined || value === null ? null : integer(value, label, min);
}

function nullableNumber(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number or null`);
  return value;
}

function binaryFlag(value, label, fallback) {
  if (value === undefined) return fallback;
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  throw new Error(`${label} must be true, false, 0, or 1`);
}

function normalizeEmbedding(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error('embedding must be a JSON string or null');
  let vector;
  try {
    vector = JSON.parse(value);
  } catch {
    throw new Error('embedding must contain valid JSON');
  }
  if (!Array.isArray(vector) || vector.length > 65536 || !vector.every((item) => typeof item === 'number' && Number.isFinite(item))) {
    throw new Error('embedding must be an array of finite numbers with at most 65536 dimensions');
  }
  return JSON.stringify(vector);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
