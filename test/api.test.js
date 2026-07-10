import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';

let app;
let base;
let rootDir;

before(async () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-api-'));
  // hermetic: point embeddings at nothing so no network calls happen during ingestion
  fs.writeFileSync(
    path.join(rootDir, 'sovereign.config.json'),
    JSON.stringify({ embeddings: { provider: 'ollama', model: '' }, providers: { ollama: { enabled: false } } })
  );
  app = createApp(rootDir, { env: {} });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => {
  app.server.close();
  app.store.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
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

async function startTempApp(config = {}, { env = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-api-isolated-'));
  fs.writeFileSync(path.join(root, 'sovereign.config.json'), JSON.stringify(config));
  const instance = createApp(root, { env });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${instance.server.address().port}`;
  return {
    app: instance,
    base: url,
    root,
    async close() {
      await new Promise((resolve) => instance.server.close(resolve));
      instance.store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function rawRequest(url, { method = 'GET', headers = {}, body } = {}) {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('status reports name and seeded personas', async () => {
  const res = await fetch(base + '/api/status');
  const status = res.status;
  const body = await res.json();
  assert.equal(status, 200);
  assert.equal(body.name, 'My Sovereign AI');
  assert.equal(body.counts.personas, 3); // seeded defaults
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('tokenless localhost rejects unsafe browser origins, hosts, and simple-request content types', async () => {
  const origin = await fetch(base + '/api/status', { headers: { origin: 'https://attacker.example' } });
  assert.equal(origin.status, 403);

  const badHost = await rawRequest(base + '/api/status', { headers: { host: 'attacker.example' } });
  assert.equal(badHost.status, 403);

  const simplePost = await fetch(base + '/api/memories', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ content: 'cross-site poison' }),
  });
  assert.equal(simplePost.status, 415);
  assert.ok(!(await get('/api/memories')).body.some((memory) => memory.content === 'cross-site poison'));
});

test('a configured bearer token is required even on loopback', async () => {
  const isolated = await startTempApp({ authToken: 'correct-horse-battery-staple' });
  try {
    assert.equal((await fetch(isolated.base + '/api/export')).status, 401);
    const authorized = await fetch(isolated.base + '/api/export', {
      headers: { authorization: 'Bearer correct-horse-battery-staple' },
    });
    assert.equal(authorized.status, 200);
  } finally {
    await isolated.close();
  }
});

test('settings updates never persist env-managed secrets and scrub matching legacy copies', async () => {
  const env = {
    SOVEREIGN_TOKEN: 'env-only-bearer-secret',
    OPENAI_API_KEY: 'env-only-openai-secret',
    ANTHROPIC_API_KEY: 'env-only-anthropic-secret',
    OLLAMA_BASE_URL: 'http://env-ollama.internal:11434',
    OPENAI_BASE_URL: 'https://env-openai.example',
  };
  const isolated = await startTempApp({
    authToken: env.SOVEREIGN_TOKEN,
    providers: {
      ollama: { enabled: true, baseUrl: 'http://localhost:11434' },
      openai: { enabled: true, baseUrl: 'https://api.openai.com', apiKey: env.OPENAI_API_KEY },
      anthropic: { enabled: true, apiKey: env.ANTHROPIC_API_KEY },
    },
  }, { env });
  const headers = {
    authorization: `Bearer ${env.SOVEREIGN_TOKEN}`,
    'content-type': 'application/json',
  };
  try {
    const currentResponse = await fetch(isolated.base + '/api/config', { headers });
    const current = await currentResponse.json();
    const saved = await fetch(isolated.base + '/api/config', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...current, name: 'Environment-safe workspace' }),
    });
    assert.equal(saved.status, 200);

    const diskText = fs.readFileSync(path.join(isolated.root, 'sovereign.config.json'), 'utf8');
    const disk = JSON.parse(diskText);
    for (const secret of [env.SOVEREIGN_TOKEN, env.OPENAI_API_KEY, env.ANTHROPIC_API_KEY]) {
      assert.doesNotMatch(diskText, new RegExp(secret));
    }
    assert.equal(disk.authToken, null);
    assert.equal(disk.providers.openai.apiKey, '');
    assert.equal(disk.providers.anthropic.apiKey, '');
    assert.notEqual(disk.providers.ollama.baseUrl, env.OLLAMA_BASE_URL);
    assert.notEqual(disk.providers.openai.baseUrl, env.OPENAI_BASE_URL);
    assert.equal(isolated.app.config.authToken, env.SOVEREIGN_TOKEN);
    assert.equal(isolated.app.config.providers.openai.apiKey, env.OPENAI_API_KEY);
    assert.equal(isolated.app.config.providers.anthropic.apiKey, env.ANTHROPIC_API_KEY);
    assert.equal(isolated.app.config.providers.ollama.baseUrl, env.OLLAMA_BASE_URL);
  } finally {
    await isolated.close();
  }
});

test('restoring into a fresh app replaces bootstrap personas instead of duplicating them', async () => {
  const source = await startTempApp({ providers: { ollama: { enabled: false } }, embeddings: { model: '' } });
  const destination = await startTempApp({ providers: { ollama: { enabled: false } }, embeddings: { model: '' } });
  try {
    const backup = source.app.store.exportAll();
    const response = await fetch(destination.base + '/api/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: backup }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(
      destination.app.store.listPersonas().map((persona) => persona.id).sort(),
      backup.personas.map((persona) => persona.id).sort()
    );
    assert.equal(destination.app.store.listPersonas().length, 3);
  } finally {
    await source.close();
    await destination.close();
  }
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
  const edited = await send('PUT', `/api/memories/${created.body.id}`, { content: 'the user loves rigorous tests' });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.content, 'the user loves rigorous tests');
  const list = await get('/api/memories');
  assert.ok(list.body.some((m) => m.content === 'the user loves rigorous tests'));
  await send('DELETE', `/api/memories/${created.body.id}`);
});

test('conversation titles can be renamed', async () => {
  const conversation = app.store.createConversation({ title: 'Old title' });
  const renamed = await send('PATCH', `/api/conversations/${conversation.id}`, { title: 'Useful new title' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.title, 'Useful new title');
  assert.equal(app.store.getConversation(conversation.id).title, 'Useful new title');
  await send('DELETE', `/api/conversations/${conversation.id}`);
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

test('malformed config updates are rejected before memory or disk changes', async () => {
  const beforeMemory = structuredClone(app.config);
  const beforeDisk = fs.readFileSync(path.join(rootDir, 'sovereign.config.json'), 'utf8');
  const res = await send('PUT', '/api/config', { providers: null });
  assert.equal(res.status, 400);
  assert.deepEqual(app.config, beforeMemory);
  assert.equal(fs.readFileSync(path.join(rootDir, 'sovereign.config.json'), 'utf8'), beforeDisk);
  assert.equal((await get('/api/providers')).status, 200);
});

test('/api/ask returns useful source ids and excerpts and forwards OpenAI limits', async () => {
  let providerRequest;
  const provider = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      providerRequest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'data: {"choices":[{"delta":{"content":"The codename is Aurora."},"finish_reason":"stop"}]}\n\n' +
          'data: {"choices":[],"usage":{"prompt_tokens":21,"completion_tokens":6}}\n\n' +
          'data: [DONE]\n\n'
      );
    });
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const providerUrl = `http://127.0.0.1:${provider.address().port}`;
  const isolated = await startTempApp({
    providers: { ollama: { enabled: false }, openai: { enabled: true, baseUrl: providerUrl } },
    defaults: { provider: 'openai', model: 'mock-model' },
    embeddings: { model: '' },
    limits: { maxTokens: 777 },
  });
  try {
    const archivist = isolated.app.store.listPersonas().find((persona) => persona.name === 'Archivist');
    const document = isolated.app.store.addDocument({
      name: 'launch-notes.md',
      size: 40,
      chunks: [{ content: 'The private launch codename is Aurora.', embedding: null }],
      embedded: false,
    });
    const response = await fetch(isolated.base + '/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'What is the launch codename?', personaId: archivist.id }),
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.answer, 'The codename is Aurora.');
    assert.equal(result.usage.input_tokens, 21);
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].documentId, document.id);
    assert.ok(result.sources[0].id);
    assert.match(result.sources[0].excerpt, /codename is Aurora/);
    assert.equal(providerRequest.max_tokens, 777);
    assert.deepEqual(providerRequest.stream_options, { include_usage: true });
  } finally {
    await isolated.close();
    await new Promise((resolve) => provider.close(resolve));
  }
});

test('disconnecting a streaming client aborts the upstream provider request', async () => {
  let upstreamClosedResolve;
  const upstreamClosed = new Promise((resolve) => (upstreamClosedResolve = resolve));
  const provider = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n');
    res.on('close', upstreamClosedResolve);
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const providerUrl = `http://127.0.0.1:${provider.address().port}`;
  const isolated = await startTempApp({
    providers: { ollama: { enabled: false }, openai: { enabled: true, baseUrl: providerUrl } },
    defaults: { provider: 'openai', model: 'mock-model' },
    embeddings: { model: '' },
  });
  try {
    await new Promise((resolve, reject) => {
      const req = http.request(
        isolated.base + '/api/chat',
        { method: 'POST', headers: { 'content-type': 'application/json' } },
        (res) => {
          let received = '';
          res.on('data', (chunk) => {
            received += chunk;
            if (received.includes('partial')) {
              res.destroy();
              resolve();
            }
          });
        }
      );
      req.on('error', reject);
      req.end(JSON.stringify({ message: 'stream until disconnected' }));
    });
    await Promise.race([
      upstreamClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('upstream was not aborted')), 1500)),
    ]);
  } finally {
    await isolated.close();
    await new Promise((resolve) => provider.close(resolve));
  }
});

test('export contains all datasets', async () => {
  const { body } = await get('/api/export');
  assert.ok(body.data.personas.length >= 3);
  assert.ok(Array.isArray(body.data.chunks));
  assert.equal('config' in body, false, 'portable exports must omit settings and secret-derived fragments entirely');
});

test('invalid imports return 400 without partial writes', async () => {
  const before = app.store.listMemories().length;
  const response = await send('POST', '/api/import', {
    data: {
      memories: [
        { id: 'valid-memory', content: 'must roll back', created_at: new Date().toISOString() },
        { id: 'invalid-memory', created_at: new Date().toISOString() },
      ],
    },
  });
  assert.equal(response.status, 400);
  assert.match(response.body.error, /Invalid memories\[1\]/);
  assert.equal(app.store.listMemories().length, before);
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
