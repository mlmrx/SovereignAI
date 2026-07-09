import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';

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

test('conversations and messages', () => {
  const { store } = tempStore();
  const convo = store.createConversation({ title: 'First chat' });
  store.addMessage({ conversation_id: convo.id, role: 'user', content: 'hi' });
  store.addMessage({ conversation_id: convo.id, role: 'assistant', content: 'hello', provider: 'ollama', model: 'llama3.1' });
  const messages = store.listMessages(convo.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[1].model, 'llama3.1');
  store.deleteConversation(convo.id);
  assert.equal(store.listConversations().length, 0);
  assert.equal(store.listMessages(convo.id).length, 0);
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
