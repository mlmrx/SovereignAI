import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ImportValidationError, openDb } from '../src/db.js';

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-test-'));
  const store = openDb(dir);
  return { store, dir };
}

test('persona CRUD', () => {
  const { store } = tempStore();
  const p = store.createPersona({ name: 'Test', system_prompt: 'Be testy', use_memory: true });
  assert.equal(store.listPersonas().length, 1);
  const updated = store.updatePersona(p.id, { name: 'Renamed', use_knowledge: true });
  assert.equal(updated.name, 'Renamed');
  assert.equal(updated.use_knowledge, 1);
  assert.equal(updated.system_prompt, 'Be testy');
  store.deletePersona(p.id);
  assert.equal(store.listPersonas().length, 0);
  store.close();
});

test('database connections enable busy waiting and foreign-key enforcement', () => {
  const { store } = tempStore();
  assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(store.db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  store.close();
});

test('database state uses private filesystem permissions on POSIX', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-permissions-'));
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o755);
  const store = openDb(dir);
  try {
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(dir, 'sovereign.db')).mode & 0o777, 0o600);
      for (const suffix of ['-wal', '-shm']) {
        const file = path.join(dir, `sovereign.db${suffix}`);
        if (fs.existsSync(file)) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      }
    }
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('conversations and messages', () => {
  const { store } = tempStore();
  const convo = store.createConversation({ title: 'First chat' });
  store.addMessage({ conversation_id: convo.id, role: 'user', content: 'hi' });
  store.addMessage({ conversation_id: convo.id, role: 'assistant', content: 'hello', provider: 'ollama', model: 'llama3.1' });
  const messages = store.listMessages(convo.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[1].model, 'llama3.1');
  const renamed = store.renameConversation(convo.id, 'Renamed chat');
  assert.equal(renamed.title, 'Renamed chat');
  store.deleteConversation(convo.id);
  assert.equal(store.listConversations().length, 0);
  assert.equal(store.listMessages(convo.id).length, 0);
  store.close();
});

test('status counts and memory edits use focused store operations', () => {
  const { store } = tempStore();
  store.createPersona({ name: 'P', system_prompt: 'S' });
  store.createConversation({ title: 'C' });
  const memory = store.addMemory('old memory');
  store.addDocument({ name: 'D', size: 1, chunks: [{ content: 'x', embedding: null }], embedded: false });

  assert.deepEqual(store.getCounts(), { personas: 1, conversations: 1, documents: 1, memories: 1, training_projects: 0 });
  assert.equal(store.updateMemory(memory.id, 'updated memory').content, 'updated memory');
  assert.equal(store.updateMemory('missing', 'nope'), null);
  store.close();
});

test('documents with chunks', () => {
  const { store } = tempStore();
  const doc = store.addDocument({
    name: 'notes.md',
    size: 100,
    chunks: [
      { content: 'chunk one', embedding: [0.1, 0.2] },
      { content: 'chunk two', embedding: null },
    ],
    embedded: true,
  });
  assert.equal(doc.chunk_count, 2);
  const chunks = store.listAllChunks();
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].document_name, 'notes.md');
  assert.deepEqual(JSON.parse(chunks[0].embedding), [0.1, 0.2]);
  store.deleteDocument(doc.id);
  assert.equal(store.listAllChunks().length, 0);
  store.close();
});

test('document creation rolls back the parent and prior chunks on failure', () => {
  const { store } = tempStore();
  assert.throws(
    () =>
      store.addDocument({
        name: 'atomic.md',
        size: 10,
        chunks: [
          { content: 'first chunk', embedding: [0.1, 0.2] },
          { content: 'invalid vector', embedding: [1n] },
        ],
        embedded: true,
      }),
    /BigInt/
  );
  assert.equal(store.listDocuments().length, 0);
  assert.equal(store.listAllChunks().length, 0);

  store.db.exec('BEGIN');
  store.addDocument({ name: 'nested.md', size: 1, chunks: [{ content: 'nested', embedding: null }], embedded: false });
  assert.equal(store.listDocuments().length, 1);
  store.db.exec('ROLLBACK');
  assert.equal(store.listDocuments().length, 0);
  store.close();
});

test('manual delete cascades roll back when the parent delete fails', () => {
  const { store } = tempStore();
  const doc = store.addDocument({
    name: 'protected.md',
    size: 4,
    chunks: [{ content: 'kept', embedding: null }],
    embedded: false,
  });
  store.db.exec(`
    CREATE TRIGGER block_document_delete BEFORE DELETE ON documents
    BEGIN SELECT RAISE(ABORT, 'document delete blocked'); END;
  `);
  assert.throws(() => store.deleteDocument(doc.id), /document delete blocked/);
  assert.equal(store.listDocuments().length, 1);
  assert.equal(store.listAllChunks().length, 1);

  const conversation = store.createConversation({ title: 'Protected' });
  store.addMessage({ conversation_id: conversation.id, role: 'user', content: 'keep me' });
  store.db.exec(`
    CREATE TRIGGER block_conversation_delete BEFORE DELETE ON conversations
    BEGIN SELECT RAISE(ABORT, 'conversation delete blocked'); END;
  `);
  assert.throws(() => store.deleteConversation(conversation.id), /conversation delete blocked/);
  assert.equal(store.listConversations().length, 1);
  assert.equal(store.listMessages(conversation.id).length, 1);

  const persona = store.createPersona({ name: 'Protected persona', system_prompt: 'Stay linked' });
  const linked = store.createConversation({ persona_id: persona.id, title: 'Linked' });
  store.db.exec(`
    CREATE TRIGGER block_persona_delete BEFORE DELETE ON personas
    BEGIN SELECT RAISE(ABORT, 'persona delete blocked'); END;
  `);
  assert.throws(() => store.deletePersona(persona.id), /persona delete blocked/);
  assert.equal(store.getConversation(linked.id).persona_id, persona.id);
  store.close();
});

test('export/import roundtrip into a fresh store', () => {
  const { store: a } = tempStore();
  a.createPersona({ name: 'P', system_prompt: 'S' });
  const convo = a.createConversation({ title: 'T' });
  a.addMessage({ conversation_id: convo.id, role: 'user', content: 'msg' });
  a.addMemory('remember me');
  a.addDocument({ name: 'd', size: 5, chunks: [{ content: 'c', embedding: null }], embedded: false });

  const dump = a.exportAll();
  const { store: b } = tempStore();
  const counts = b.importAll(dump);
  assert.equal(counts.personas, 1);
  assert.equal(counts.messages, 1);
  assert.equal(b.listMemories()[0].content, 'remember me');
  assert.equal(b.listAllChunks().length, 1);
  a.close();
  b.close();
});

test('import validates every row before writing anything', () => {
  const { store: source } = tempStore();
  source.addMemory('valid first row');
  const dump = source.exportAll();
  dump.memories.push({ id: 'broken-memory', created_at: new Date().toISOString() });

  const { store: target } = tempStore();
  assert.throws(() => target.importAll(dump), ImportValidationError);
  assert.equal(target.listMemories().length, 0);
  source.close();
  target.close();
});

test('import normalizes legacy persona refs and rejects corrupt child rows', () => {
  const { store } = tempStore();
  const stamp = new Date().toISOString();
  store.importAll({
    conversations: [
      { id: 'legacy-conversation', persona_id: 'deleted-persona', title: 'Legacy', created_at: stamp, updated_at: stamp },
    ],
  });
  assert.equal(store.getConversation('legacy-conversation').persona_id, null);
  assert.throws(
    () =>
      store.importAll({
        messages: [
          {
            id: 'message-1',
            conversation_id: 'missing-conversation',
            role: 'user',
            content: 'orphan',
            created_at: stamp,
          },
        ],
      }),
    /conversation_id/
  );
  assert.throws(
    () =>
      store.importAll({
        documents: [{ id: 'doc-1', name: 'bad', size: 3, chunk_count: 2, embedded: 1, created_at: stamp }],
        chunks: [{ id: 'chunk-1', document_id: 'doc-1', idx: 0, content: 'x', embedding: '[0.1,0.2]' }],
      }),
    /chunk_count/
  );
  assert.throws(
    () =>
      store.importAll({
        documents: [{ id: 'doc-2', name: 'bad vector', size: 3, chunk_count: 1, embedded: 1, created_at: stamp }],
        chunks: [{ id: 'chunk-2', document_id: 'doc-2', idx: 0, content: 'x', embedding: '{"not":"a vector"}' }],
      }),
    /embedding/
  );
  assert.equal(store.listDocuments().length, 0);
  store.close();
});

test('import rolls back earlier tables when SQLite rejects a later row', () => {
  const { store: source } = tempStore();
  source.createPersona({ name: 'Would be partial', system_prompt: 'Never partial' });
  source.addMemory('blocked by trigger');
  const dump = source.exportAll();

  const { store: target } = tempStore();
  target.db.exec(`
    CREATE TRIGGER block_memory_import BEFORE INSERT ON memories
    BEGIN SELECT RAISE(ABORT, 'memory import blocked'); END;
  `);
  assert.throws(() => target.importAll(dump), /memory import blocked/);
  assert.equal(target.listPersonas().length, 0);
  assert.equal(target.listMemories().length, 0);
  source.close();
  target.close();
});
