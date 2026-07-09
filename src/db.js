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
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'sovereign.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return new Store(db);
}

export class Store {
  constructor(db) {
    this.db = db;
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
    this.db.prepare('DELETE FROM personas WHERE id = ?').run(id);
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

  deleteConversation(id) {
    this.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
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

  addMemory(content) {
    const row = { id: newId(), content, created_at: now() };
    this.db.prepare('INSERT INTO memories (id, content, created_at) VALUES (:id, :content, :created_at)').run(row);
    return row;
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
    this.db
      .prepare('INSERT INTO documents (id, name, size, chunk_count, embedded, created_at) VALUES (:id, :name, :size, :chunk_count, :embedded, :created_at)')
      .run(doc);
    const insert = this.db.prepare('INSERT INTO chunks (id, document_id, idx, content, embedding) VALUES (?, ?, ?, ?, ?)');
    for (let i = 0; i < chunks.length; i++) {
      insert.run(newId(), doc.id, i, chunks[i].content, chunks[i].embedding ? JSON.stringify(chunks[i].embedding) : null);
    }
    return doc;
  }

  deleteDocument(id) {
    this.db.prepare('DELETE FROM chunks WHERE document_id = ?').run(id);
    this.db.prepare('DELETE FROM documents WHERE id = ?').run(id);
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

  importAll(data) {
    const tables = {
      personas: 'INSERT OR REPLACE INTO personas (id, name, description, system_prompt, provider, model, temperature, use_memory, use_knowledge, created_at, updated_at) VALUES (:id, :name, :description, :system_prompt, :provider, :model, :temperature, :use_memory, :use_knowledge, :created_at, :updated_at)',
      conversations: 'INSERT OR REPLACE INTO conversations (id, persona_id, title, created_at, updated_at) VALUES (:id, :persona_id, :title, :created_at, :updated_at)',
      messages: 'INSERT OR REPLACE INTO messages (id, conversation_id, role, content, provider, model, tokens_in, tokens_out, created_at) VALUES (:id, :conversation_id, :role, :content, :provider, :model, :tokens_in, :tokens_out, :created_at)',
      memories: 'INSERT OR REPLACE INTO memories (id, content, created_at) VALUES (:id, :content, :created_at)',
      documents: 'INSERT OR REPLACE INTO documents (id, name, size, chunk_count, embedded, created_at) VALUES (:id, :name, :size, :chunk_count, :embedded, :created_at)',
      chunks: 'INSERT OR REPLACE INTO chunks (id, document_id, idx, content, embedding) VALUES (:id, :document_id, :idx, :content, :embedding)',
    };
    const counts = {};
    for (const [table, sql] of Object.entries(tables)) {
      const rows = data[table];
      if (!Array.isArray(rows)) continue;
      const stmt = this.db.prepare(sql);
      for (const row of rows) stmt.run(row);
      counts[table] = rows.length;
    }
    return counts;
  }

  close() {
    this.db.close();
  }
}
