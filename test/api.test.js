import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';

let app;
let base;

before(async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-api-'));
  // hermetic: point embeddings at nothing so no network calls happen during ingestion
  fs.writeFileSync(
    path.join(rootDir, 'sovereign.config.json'),
    JSON.stringify({ embeddings: { provider: 'ollama', model: '' }, providers: { ollama: { enabled: false } } })
  );
  app = createApp(rootDir);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => {
  app.server.close();
  app.store.close();
});

async function get(pathname) {
  const res = await fetch(base + pathname);
  return { status: res.status, body: await res.json() };
}
async function send(method, pathname, body) {
  const res = await fetch(base + pathname, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('status reports name and seeded personas', async () => {
  const { status, body } = await get('/api/status');
  assert.equal(status, 200);
  assert.equal(body.name, 'My Sovereign AI');
  assert.equal(body.counts.personas, 3); // seeded defaults
});

test('personas CRUD over HTTP', async () => {
  const created = await send('POST', '/api/personas', { name: 'API Test', system_prompt: 'test' });
  assert.equal(created.status, 200);
  const updated = await send('PUT', `/api/personas/${created.body.id}`, { name: 'API Test 2' });
  assert.equal(updated.body.name, 'API Test 2');
  const del = await send('DELETE', `/api/personas/${created.body.id}`);
  assert.equal(del.body.ok, true);
});

test('memories round-trip', async () => {
  const created = await send('POST', '/api/memories', { content: 'the user likes tests' });
  assert.equal(created.status, 200);
  const list = await get('/api/memories');
  assert.ok(list.body.some((m) => m.content === 'the user likes tests'));
  await send('DELETE', `/api/memories/${created.body.id}`);
});

test('document ingestion and keyword search', async () => {
  const doc = await send('POST', '/api/documents', {
    name: 'manifesto.md',
    content: 'Sovereign AI means the user owns the runtime, the memory, and the data. '.repeat(30),
  });
  assert.equal(doc.status, 200);
  assert.ok(doc.body.chunk_count >= 1);
  assert.equal(doc.body.embedded, 0); // embeddings disabled in this test config

  const search = await get('/api/search?q=' + encodeURIComponent('who owns the runtime?'));
  assert.equal(search.status, 200);
  assert.ok(search.body.length >= 1);
  assert.equal(search.body[0].method, 'keyword');
});

test('config redacts secrets and merge keeps them', async () => {
  await send('PUT', '/api/config', { providers: { anthropic: { enabled: true, apiKey: 'sk-ant-secret123456' } } });
  const cfg = await get('/api/config');
  assert.ok(cfg.body.providers.anthropic.apiKey.includes('••'), 'key must be masked');
  // sending the masked value back must not overwrite the real key
  await send('PUT', '/api/config', { providers: { anthropic: cfg.body.providers.anthropic } });
  assert.equal(app.config.providers.anthropic.apiKey, 'sk-ant-secret123456');
});

test('export contains all datasets', async () => {
  const { body } = await get('/api/export');
  assert.ok(body.data.personas.length >= 3);
  assert.ok(Array.isArray(body.data.chunks));
  assert.ok(body.config.providers.anthropic.apiKey.includes('••'), 'export must not leak keys');
});

test('chat with unconfigured provider fails cleanly', async () => {
  const res = await fetch(base + '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'hello' }),
  });
  // SSE stream should carry an error event (ollama disabled in test config)
  const text = await res.text();
  assert.ok(text.includes('event: error'), `expected SSE error, got: ${text.slice(0, 200)}`);
  assert.ok(text.includes('not configured'));
});

test('unknown API route 404s', async () => {
  const { status } = await get('/api/nonexistent');
  assert.equal(status, 404);
});
