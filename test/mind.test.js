import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';

const root = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'app.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');

async function startTempApp(config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-mind-'));
  fs.writeFileSync(path.join(dir, 'sovereign.config.json'), JSON.stringify(config));
  const instance = createApp(dir, { env: {}, hardware: { detectGpu: async () => null } });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  return {
    app: instance,
    base: `http://127.0.0.1:${instance.server.address().port}`,
    async close() {
      await new Promise((resolve) => instance.server.close(resolve));
      instance.store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seedImportedConversation(store, { externalId, title, distilled = false }) {
  const conversation = store.importConversation({
    title,
    external_id: externalId,
    source_platform: 'chatgpt',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  });
  store.importMessage({ conversation_id: conversation.id, role: 'user', content: 'I build SovereignAI on Windows and prefer terse replies.' });
  store.importMessage({ conversation_id: conversation.id, role: 'assistant', content: 'Noted — terse it is.' });
  if (distilled) store.markConversationDistilled(conversation.id);
  return conversation;
}

async function readSse(response) {
  const events = [];
  const text = await response.text();
  for (const block of text.split('\n\n')) {
    let event = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (data.length) events.push({ event, data: JSON.parse(data.join('\n')) });
  }
  return events;
}

test('GET /api/mind reports provenance counts, receipts, and import state honestly', async () => {
  const isolated = await startTempApp({
    name: 'Mia',
    embeddings: { provider: 'ollama', model: '' },
    providers: { ollama: { enabled: false } },
  });
  try {
    const { store } = isolated.app;
    const convo = seedImportedConversation(store, { externalId: 'ext-mind-1', title: 'Setup talk' });
    seedImportedConversation(store, { externalId: 'ext-mind-2', title: 'Old sweep', distilled: true });
    store.addMemory('Owner note');
    store.addMemory('Extracted from live chat', { origin: 'extracted', sourceConversationId: convo.id });
    store.addMemory('From a gone conversation', { origin: 'distilled', sourceConversationId: 'deleted-convo' });
    store.db.prepare("INSERT INTO memories (id, content, created_at) VALUES ('legacy', 'Pre-tracking', '2026-01-01T00:00:00.000Z')").run();

    const res = await fetch(`${isolated.base}/api/mind`);
    assert.equal(res.status, 200);
    const mind = await res.json();
    assert.equal(mind.name, 'Mia');
    assert.deepEqual(
      { manual: mind.memories.manual, extracted: mind.memories.extracted, distilled: mind.memories.distilled, untracked: mind.memories.untracked, total: mind.memories.total },
      { manual: 1, extracted: 1, distilled: 1, untracked: 1, total: 4 }
    );
    const extracted = mind.memories.recent.find((m) => m.origin === 'extracted');
    assert.equal(extracted.source.title, 'Setup talk');
    assert.equal(extracted.source.deleted, false);
    const orphan = mind.memories.recent.find((m) => m.origin === 'distilled');
    assert.equal(orphan.source.deleted, true, 'a deleted source conversation must be reported, not hidden');
    assert.deepEqual(mind.imports, {
      platforms: [{ platform: 'chatgpt', conversations: 2, undistilled: 1 }],
      conversations: 2,
      undistilled: 1,
    });
  } finally {
    await isolated.close();
  }
});

test('POST /api/distill streams per-conversation progress and stays idempotent', async () => {
  const provider = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'data: {"choices":[{"delta":{"content":"- Builds SovereignAI on Windows"},"finish_reason":"stop"}]}\n\n' +
          'data: [DONE]\n\n'
      );
    });
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const isolated = await startTempApp({
    embeddings: { provider: 'ollama', model: '' },
    defaults: { provider: 'openai', model: 'mock-model' },
    providers: { ollama: { enabled: false }, openai: { enabled: true, baseUrl: `http://127.0.0.1:${provider.address().port}` } },
  });
  try {
    const { store } = isolated.app;
    const convo = seedImportedConversation(store, { externalId: 'ext-sse-1', title: 'History chat' });

    const first = await fetch(`${isolated.base}/api/distill`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(first.status, 200);
    assert.match(first.headers.get('content-type') ?? '', /text\/event-stream/);
    const events = await readSse(first);
    assert.equal(events[0].event, 'meta');
    assert.equal(events[0].data.total, 1);
    const swept = events.find((e) => e.event === 'conversation');
    assert.equal(swept.data.conversationId, convo.id);
    assert.deepEqual(swept.data.facts, ['Builds SovereignAI on Windows']);
    const done = events.at(-1);
    assert.equal(done.event, 'done');
    assert.deepEqual(done.data, { conversations: 1, memoriesAdded: 1, remaining: 0 });

    const memory = store.listMemories().find((m) => m.content === 'Builds SovereignAI on Windows');
    assert.equal(memory.origin, 'distilled');
    assert.equal(memory.source_conversation_id, convo.id);
    assert.equal(memory.author_provider, 'openai', 'machine-written memories must name their authoring provider');
    assert.equal(memory.author_model, 'mock-model', 'machine-written memories must name their authoring model');

    // Second run: everything already swept — no model calls, immediate done.
    const second = await readSse(
      await fetch(`${isolated.base}/api/distill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    );
    assert.deepEqual(second.at(-1), { event: 'done', data: { conversations: 0, memoriesAdded: 0, remaining: 0 } });
  } finally {
    await isolated.close();
    await new Promise((resolve) => provider.close(resolve));
  }
});

test('POST /api/distill reports a provider failure without marking the failed conversation', async () => {
  const provider = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"model exploded"}}');
    });
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const isolated = await startTempApp({
    embeddings: { provider: 'ollama', model: '' },
    defaults: { provider: 'openai', model: 'mock-model' },
    providers: { ollama: { enabled: false }, openai: { enabled: true, baseUrl: `http://127.0.0.1:${provider.address().port}` } },
  });
  try {
    const { store } = isolated.app;
    seedImportedConversation(store, { externalId: 'ext-fail-1', title: 'Doomed sweep' });
    const events = await readSse(
      await fetch(`${isolated.base}/api/distill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    );
    const failure = events.at(-1);
    assert.equal(failure.event, 'error');
    assert.equal(failure.data.completed, 0);
    assert.equal(store.listDistillableConversations().length, 1, 'the failed conversation must remain sweepable');
  } finally {
    await isolated.close();
    await new Promise((resolve) => provider.close(resolve));
  }
});

test('cognition stays home: distillation refuses remote memory-writers; config round-trips the switch', async () => {
  const isolated = await startTempApp({
    embeddings: { provider: 'ollama', model: '' },
    defaults: { provider: 'anthropic', model: 'claude-sonnet-5' },
    providers: { ollama: { enabled: false }, anthropic: { enabled: true, apiKey: 'sk-ant-test' } },
    memory: { autoExtract: false, extractLocalOnly: true },
  });
  try {
    const { store } = isolated.app;
    seedImportedConversation(store, { externalId: 'ext-local-1', title: 'Should not reach Anthropic' });
    const events = await readSse(
      await fetch(`${isolated.base}/api/distill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    );
    const failure = events.at(-1);
    assert.equal(failure.event, 'error');
    assert.match(failure.data.message, /extractLocalOnly.*not a local endpoint/s);
    assert.equal(store.listDistillableConversations().length, 1, 'nothing may be marked distilled');
    assert.equal(store.listMemories().length, 0, 'no memory may be written by a remote model');

    const updated = await fetch(`${isolated.base}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ memory: { autoExtract: true, extractLocalOnly: false } }),
    });
    assert.equal(updated.status, 200);
    const config = await updated.json();
    assert.equal(config.memory.extractLocalOnly, false);
    assert.equal(config.memory.autoExtract, true);
  } finally {
    await isolated.close();
  }
});

test('cognition stays home: auto-extract silently skips remote providers', async () => {
  const { autoExtractMemories } = await import('../src/memory-extract.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-extract-'));
  const { openDb } = await import('../src/db.js');
  const store = openDb(dir);
  try {
    await autoExtractMemories({
      store,
      config: {
        defaults: { provider: 'anthropic', model: 'claude-sonnet-5' },
        providers: { anthropic: { enabled: true, apiKey: 'sk-ant-test', baseUrl: 'https://api.anthropic.com' } },
        memory: { autoExtract: true, extractLocalOnly: true },
      },
      userMessage: 'I am the founder of SovereignAI.',
      assistantReply: 'Understood.',
    });
    assert.equal(store.listMemories().length, 0, 'no extraction call may run against a remote provider');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Mind view and Arrival markup are wired: ids resolve, handlers bound, styles present', () => {
  const ids = [...html.matchAll(/\bid="([A-Za-z][\w:-]*)"/g)].map((match) => match[1]);
  for (const required of [
    'view-mind', 'mind-ignition', 'mind-ledger-list', 'mind-imports-body', 'mind-distill-btn',
    'arrival', 'arrival-drop', 'arrival-file', 'arrival-feed', 'arrival-greeting', 'arrival-skip',
  ]) {
    assert.ok(ids.includes(required), `missing #${required} in app.html`);
  }
  for (const [id, event] of Object.entries({
    'mind-arrival-btn': 'click',
    'mind-portfolio-btn': 'click',
    'mind-distill-btn': 'click',
    'arrival-drop': 'drop',
    'arrival-file': 'change',
    'arrival-skip': 'click',
  })) {
    assert.match(appJs, new RegExp(`\\$\\('#${id}'\\)\\.addEventListener\\('${event}'`), `#${id} must handle ${event}`);
  }
  assert.match(appJs, /function\s+loadMind\s*\(/);
  assert.match(appJs, /function\s+maybeAutoOpenArrival\s*\(/);
  assert.match(appJs, /routeFromHash\(\) \|\| 'mind'/, 'mind must be the default landing view');
  assert.match(appJs, /recorded before provenance tracking/i, 'untracked origins must be labeled honestly');
  assert.match(html, /data-view="home"/, 'the command center must remain reachable');
  assert.match(html, /id="view-home"/, 'the existing dashboard must not be removed');
  assert.match(css, /\.mind-grid/);
  assert.match(css, /\.arrival-drop/);
  assert.match(css, /@media \(max-width: 1100px\)[\s\S]*\.mind-grid \{ grid-template-columns: 1fr; \}/);
});
