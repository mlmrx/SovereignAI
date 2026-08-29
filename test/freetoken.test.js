// FreeToken: a local MoE engine served on loopback with no auth. Its chat
// surface is OpenAI-compatible, so what is pinned here is what is FreeToken's
// own — the /health readiness rules, the keyless config shape, the doctor's
// detection of a running-but-disabled engine, and the end-to-end wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freetoken } from '../src/providers/freetoken.js';
import { providers, detectLocalFreeToken } from '../src/providers/index.js';
import { DEFAULT_CONFIG, ConfigValidationError, loadConfig, mergeConfigUpdate } from '../src/config.js';
import { createApp } from '../src/server.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'bin', 'sovereign.js');

// ---- helpers ----

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Run fn with globalThis.fetch replaced; always restores. */
async function withFetch(impl, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const cfg = { enabled: true, baseUrl: 'http://127.0.0.1:1919' };
const serving = { status: 'ok', model: 'mock-model', instance_id: 'i-1', uptime_s: 12, maintenance: 'serving', version: '0.1.2' };

/**
 * A stand-in FreeToken server. `state.health` is what /health answers;
 * paths are matched by suffix so a baseUrl with a path prefix still works
 * (that prefix is how the doctor tests prove endpoints are printed host-only).
 */
async function startMockFreeToken(state = { health: serving }) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ method: req.method, path: url.pathname, headers: req.headers });
    req.resume();
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && url.pathname.endsWith('/health')) return reply(200, state.health);
    if (req.method === 'GET' && url.pathname.endsWith('/v1/models')) {
      return reply(200, { object: 'list', data: [{ id: 'mock-model', object: 'model', created: 1, owned_by: 'FreeToken', root: '/weights/mock-model' }] });
    }
    if (req.method === 'POST' && url.pathname.endsWith('/v1/chat/completions')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"hello from FreeToken"},"finish_reason":null}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
      res.write('data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":4,"total_tokens":11}}\n\n');
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    reply(404, { detail: 'Not Found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startTempApp(config = {}, { env = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-freetoken-'));
  fs.writeFileSync(path.join(root, 'sovereign.config.json'), JSON.stringify(config));
  const instance = createApp(root, { env, hardware: { detectGpu: async () => null } });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  return {
    app: instance,
    base: `http://127.0.0.1:${instance.server.address().port}`,
    root,
    async close() {
      await new Promise((resolve) => instance.server.close(resolve));
      instance.store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function parseSse(text) {
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('event:'))
    .map((block) => {
      const event = block.match(/^event: (.+)$/m)[1];
      const data = JSON.parse(block.match(/^data: (.+)$/m)[1]);
      return { event, data };
    });
}

function makeTemp(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sovereign-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The doctor talks to an in-process mock server, so the CLI must run
// asynchronously — spawnSync would block the loop the mock answers on.
// The developer's shell may carry provider overrides (OLLAMA_BASE_URL, API keys…);
// none of them may leak into what these tests assert about the doctor's verdict.
function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(SOVEREIGN_|OLLAMA_|FREETOKEN_|OPENAI_|ANTHROPIC_)/.test(key)) delete env[key];
  }
  return env;
}

function runCli(args, { home }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', cli, ...args], {
      cwd: repo,
      env: { ...cleanEnv(), SOVEREIGN_HOME: home },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), 20_000);
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, output: stdout + stderr });
    });
  });
}

/** Seed a doctor home: config on disk plus a database, so nothing else warns. */
async function seedDoctorHome(t, config) {
  const home = path.join(makeTemp(t, 'doctor-freetoken'), 'state');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'sovereign.config.json'), JSON.stringify({ name: 'FreeToken Doctor', setupComplete: true, embeddings: { provider: 'ollama', model: '' }, ...config }));
  const seeded = await runCli(['export', path.join(home, 'seed.json')], { home });
  assert.equal(seeded.status, 0, seeded.stderr);
  return home;
}

// ---- provider unit ----

test('FreeToken is registered as a keyless local provider between Ollama and the remote ones', () => {
  assert.deepEqual(Object.keys(providers), ['ollama', 'freetoken', 'openai', 'anthropic']);
  assert.equal(freetoken.id, 'freetoken');
  assert.equal(freetoken.label, 'FreeToken');
  assert.equal(freetoken.isConfigured({ enabled: true, baseUrl: 'http://127.0.0.1:1919' }), true);
  assert.equal(freetoken.isConfigured({ enabled: false, baseUrl: 'http://127.0.0.1:1919' }), false);
  assert.equal(freetoken.isConfigured({ enabled: true }), false);
  assert.equal('authorization' in freetoken.headers(cfg), false, 'no key, no auth header');
});

test('FreeToken health reports the served model and version when the engine is serving', async () => {
  const result = await withFetch(async (url) => {
    assert.equal(url, 'http://127.0.0.1:1919/health');
    return jsonResponse(serving);
  }, () => freetoken.health(cfg));
  assert.equal(result.ok, true);
  assert.match(result.detail, /FreeToken 0\.1\.2 · serving mock-model/);
});

test('FreeToken health treats a missing maintenance field as serving', async () => {
  const { maintenance, ...legacy } = serving;
  const result = await withFetch(async () => jsonResponse(legacy), () => freetoken.health(cfg));
  assert.equal(result.ok, true);
  assert.match(result.detail, /serving mock-model/);
});

test('FreeToken health explains a loading engine with phase and progress', async () => {
  const loading = { status: 'loading', phase: 'weights', progress: { done_bytes: 42, total_bytes: 100 }, model: 'mock-model', instance_id: 'i-1' };
  await assert.rejects(
    withFetch(async () => jsonResponse(loading), () => freetoken.health(cfg)),
    /still loading mock-model \(weights 42%\)/
  );
  const unknownSize = { ...loading, model: null, progress: { done_bytes: 0, total_bytes: 0 } };
  await assert.rejects(
    withFetch(async () => jsonResponse(unknownSize), () => freetoken.health(cfg)),
    /still loading its model \(weights\)$/
  );
});

test('FreeToken health surfaces an engine error message', async () => {
  await assert.rejects(
    withFetch(async () => jsonResponse({ status: 'error', message: 'boom', instance_id: 'i-1' }), () => freetoken.health(cfg)),
    /engine error: boom/
  );
});

test('FreeToken health is not ready while status is ok but maintenance is not serving', async () => {
  await assert.rejects(
    withFetch(async () => jsonResponse({ ...serving, maintenance: 'rebuilding' }), () => freetoken.health(cfg)),
    /not serving right now \(rebuilding\)/
  );
});

test('FreeToken health rejects a server that is not FreeToken-shaped', async () => {
  await assert.rejects(
    withFetch(async () => jsonResponse({ status: 'ok' }), () => freetoken.health(cfg)),
    /unexpected shape/
  );
  await assert.rejects(
    withFetch(async () => new Response('<html>not json</html>', { status: 200 }), () => freetoken.health(cfg)),
    /unexpected shape/
  );
});

test('FreeToken health rejects on an HTTP error', async () => {
  await assert.rejects(
    withFetch(async () => jsonResponse({ detail: 'Not Found' }, 404), () => freetoken.health(cfg)),
    /FreeToken/
  );
});

test('FreeToken health keeps server-provided strings to one bounded line', async () => {
  const messy = { ...serving, model: 'evil\nmodel' + 'x'.repeat(500), version: '0.1.2\r\n' };
  const result = await withFetch(async () => jsonResponse(messy), () => freetoken.health(cfg));
  assert.doesNotMatch(result.detail, /[\u0000-\u001f\u007f]/);
  assert.match(result.detail, /^FreeToken 0\.1\.2 · serving evil model/);
  assert.ok(result.detail.length < 300);
});

test('FreeToken lists the served model through the OpenAI-compatible endpoint', async () => {
  const models = await withFetch(async (url) => {
    assert.equal(url, 'http://127.0.0.1:1919/v1/models');
    return jsonResponse({ object: 'list', data: [{ id: 'mock-model', object: 'model', owned_by: 'FreeToken' }] });
  }, () => freetoken.listModels(cfg));
  assert.deepEqual(models, [{ id: 'mock-model', label: 'mock-model' }]);
});

test('FreeToken chat streams deltas and never sends an authorization header', async () => {
  let request;
  const parts = await withFetch(async (url, options) => {
    request = { url, headers: options.headers, body: JSON.parse(options.body) };
    return new Response(
      'data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"delta":{"reasoning_content":"thinking"},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n' +
        'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    );
  }, async () => {
    const collected = [];
    for await (const part of freetoken.chatStream({ cfg, model: 'mock-model', messages: [{ role: 'user', content: 'Hi' }], maxTokens: 64 })) {
      collected.push(part);
    }
    return collected;
  });
  assert.equal(request.url, 'http://127.0.0.1:1919/v1/chat/completions');
  assert.equal(Object.keys(request.headers).some((key) => key.toLowerCase() === 'authorization'), false);
  assert.equal(request.body.model, 'mock-model');
  // The reasoning_content chunk surfaces as its own part (shown live, never stored).
  assert.deepEqual(parts, [
    { type: 'reasoning', text: 'thinking' },
    { type: 'delta', text: 'hi' },
    { type: 'done', usage: { input_tokens: 3, output_tokens: 1 }, stopReason: 'stop' },
  ]);
});

// ---- config ----

test('FreeToken defaults to disabled on loopback with no key field at all', () => {
  assert.deepEqual(DEFAULT_CONFIG.providers.freetoken, { enabled: false, baseUrl: 'http://127.0.0.1:1919' });
  assert.deepEqual(Object.keys(DEFAULT_CONFIG.providers), ['ollama', 'freetoken', 'openai', 'anthropic']);
});

test('config accepts FreeToken as a provider and as the default provider', () => {
  const merged = mergeConfigUpdate(DEFAULT_CONFIG, {
    providers: { freetoken: { enabled: true, baseUrl: 'http://127.0.0.1:1919/' } },
    defaults: { provider: 'freetoken', model: 'mock-model' },
  });
  assert.deepEqual(merged.providers.freetoken, { enabled: true, baseUrl: 'http://127.0.0.1:1919' });
  assert.equal(merged.defaults.provider, 'freetoken');
  assert.equal('apiKey' in merged.providers.freetoken, false);
});

test('config rejects an API key for FreeToken and a metadata address as its endpoint', () => {
  assert.throws(
    () => mergeConfigUpdate(DEFAULT_CONFIG, { providers: { freetoken: { apiKey: 'sk-nope' } } }),
    (err) => err instanceof ConfigValidationError && /providers\.freetoken contains unknown field "apiKey"/.test(err.message)
  );
  assert.throws(
    () => mergeConfigUpdate(DEFAULT_CONFIG, { providers: { freetoken: { baseUrl: 'http://169.254.169.254' } } }),
    (err) => err instanceof ConfigValidationError && /providers\.freetoken\.baseUrl may not point at/.test(err.message)
  );
});

test('FREETOKEN_BASE_URL sets the endpoint and switches the provider on', (t) => {
  const root = makeTemp(t, 'freetoken-env');
  const config = loadConfig(root, { env: { FREETOKEN_BASE_URL: 'http://freetoken:1919' } });
  assert.equal(config.providers.freetoken.baseUrl, 'http://freetoken:1919');
  assert.equal(config.providers.freetoken.enabled, true);
  const plain = loadConfig(root, { env: {} });
  assert.equal(plain.providers.freetoken.enabled, false);
});

test('an env-managed FreeToken endpoint is never written to disk by a settings save', async () => {
  const env = { FREETOKEN_BASE_URL: 'http://env-freetoken.internal:1919' };
  const isolated = await startTempApp({ providers: { ollama: { enabled: false } }, embeddings: { model: '' } }, { env });
  try {
    const current = await (await fetch(isolated.base + '/api/config')).json();
    assert.equal(current.providers.freetoken.baseUrl, env.FREETOKEN_BASE_URL);
    assert.equal(current.providers.freetoken.enabled, true);
    const saved = await fetch(isolated.base + '/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...current, name: 'Environment-safe workspace' }),
    });
    assert.equal(saved.status, 200);

    const disk = JSON.parse(fs.readFileSync(path.join(isolated.root, 'sovereign.config.json'), 'utf8'));
    assert.equal(disk.name, 'Environment-safe workspace');
    assert.notEqual(disk.providers.freetoken.baseUrl, env.FREETOKEN_BASE_URL);
    assert.equal(disk.providers.freetoken.enabled, false, 'enabled came from the env, not the user');
    assert.equal(isolated.app.config.providers.freetoken.baseUrl, env.FREETOKEN_BASE_URL);
    assert.equal(isolated.app.config.providers.freetoken.enabled, true);
  } finally {
    await isolated.close();
  }
});

// ---- server ----

test('the server reports, lists and chats with a FreeToken engine end to end', async () => {
  const mock = await startMockFreeToken();
  const isolated = await startTempApp({
    providers: { ollama: { enabled: false }, freetoken: { enabled: true, baseUrl: mock.url } },
    defaults: { provider: 'freetoken', model: 'mock-model' },
    embeddings: { model: '' },
  });
  try {
    const status = await (await fetch(isolated.base + '/api/providers')).json();
    assert.deepEqual(status.map((row) => row.id), ['ollama', 'freetoken', 'openai', 'anthropic']);
    const row = status.find((entry) => entry.id === 'freetoken');
    assert.equal(row.label, 'FreeToken');
    assert.equal(row.enabled, true);
    assert.equal(row.configured, true);
    assert.equal(row.ok, true);
    assert.match(row.detail, /serving mock-model/);

    const models = await (await fetch(isolated.base + '/api/models?provider=freetoken')).json();
    assert.equal(models.provider, 'freetoken');
    assert.deepEqual(models.models.map((model) => model.id), ['mock-model']);

    const chat = await fetch(isolated.base + '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    assert.equal(chat.status, 200);
    const events = parseSse(await chat.text());
    const meta = events.find((event) => event.event === 'meta');
    assert.equal(meta.data.provider, 'freetoken');
    assert.equal(meta.data.model, 'mock-model');
    assert.ok(events.some((event) => event.event === 'delta' && event.data.text === 'hello from FreeToken'));
    const done = events.find((event) => event.event === 'done');
    assert.ok(done, 'a done event is sent');
    assert.equal(done.data.modelDigest, null, 'FreeToken has no weight digest; reported as unknown, not guessed');
    assert.deepEqual(done.data.usage, { input_tokens: 7, output_tokens: 4 });

    const messages = isolated.app.store.listMessages(done.data.conversationId);
    const reply = messages.find((message) => message.role === 'assistant');
    assert.equal(reply.provider, 'freetoken');
    assert.equal(reply.model, 'mock-model');
    assert.equal(reply.content, 'hello from FreeToken');

    const chatRequest = mock.requests.find((request) => request.path.endsWith('/v1/chat/completions'));
    assert.equal('authorization' in chatRequest.headers, false, 'nothing secret-shaped leaves for a keyless engine');
  } finally {
    await isolated.close();
    await mock.close();
  }
});

// ---- doctor ----

test('doctor --no-network skips a disabled FreeToken without opening a socket', async (t) => {
  // A live engine at the configured URL proves the gate: with --no-network it must
  // receive nothing at all, not merely be reported as disabled.
  const mock = await startMockFreeToken();
  const home = await seedDoctorHome(t, {
    providers: {
      ollama: { enabled: true, baseUrl: 'http://localhost:11434/private' },
      freetoken: { enabled: false, baseUrl: mock.url },
    },
    defaults: { provider: 'ollama', model: 'llama3.1:latest' },
  });
  try {
    const result = await runCli(['doctor', '--no-network'], { home });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /\[skip\] FreeToken — disabled/);
    assert.doesNotMatch(result.output, /\[info\] FreeToken/);
    assert.doesNotMatch(result.output, /\/private/);
    assert.equal(mock.requests.length, 0, 'no request may reach the engine under --no-network');
  } finally {
    await mock.close();
  }
});

test('doctor leaves a disabled FreeToken alone when its URL is not on this machine', async (t) => {
  const mock = await startMockFreeToken();
  // Same mock, reached through a non-loopback name: detection is for the engine on
  // this machine only, so nothing is probed and the plain disabled line is printed.
  const home = await seedDoctorHome(t, {
    providers: {
      ollama: { enabled: false },
      freetoken: { enabled: false, baseUrl: mock.url.replace('127.0.0.1', 'freetoken.lan') },
      openai: { enabled: true, baseUrl: mock.url, apiKey: '' },
    },
    defaults: { provider: 'openai', model: 'mock-model' },
  });
  try {
    const result = await runCli(['doctor'], { home });
    assert.match(result.output, /\[skip\] FreeToken — disabled/);
    assert.doesNotMatch(result.output, /\[info\] FreeToken/);
    assert.equal(mock.requests.filter((request) => request.path === '/health').length, 0);
  } finally {
    await mock.close();
  }
});

test('doctor notices a running FreeToken that is not enabled, without changing the verdict', async (t) => {
  const mock = await startMockFreeToken();
  const home = await seedDoctorHome(t, {
    providers: {
      ollama: { enabled: false },
      freetoken: { enabled: false, baseUrl: `${mock.url}/private` },
      openai: { enabled: true, baseUrl: mock.url, apiKey: '' },
    },
    defaults: { provider: 'openai', model: 'mock-model' },
  });
  try {
    const result = await runCli(['doctor'], { home });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /\[info\] FreeToken — running at http:\/\/127\.0\.0\.1:\d+ \(mock-model\) but not enabled/);
    assert.match(result.output, /Next steps:[\s\S]*Enable FreeToken/);
    assert.match(result.output, /Result: ready\./);
    assert.doesNotMatch(result.output, /\/private/);
    assert.doesNotMatch(result.output, /\/health/);
  } finally {
    await mock.close();
  }
});

test('doctor stays quiet about a disabled FreeToken when nothing FreeToken-shaped answers', async (t) => {
  const other = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' })); // some other service: no instance_id
  });
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
  const mock = await startMockFreeToken();
  const home = await seedDoctorHome(t, {
    providers: {
      ollama: { enabled: false },
      freetoken: { enabled: false, baseUrl: `http://127.0.0.1:${other.address().port}` },
      openai: { enabled: true, baseUrl: mock.url, apiKey: '' },
    },
    defaults: { provider: 'openai', model: 'mock-model' },
  });
  try {
    const result = await runCli(['doctor'], { home });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /\[skip\] FreeToken — disabled/);
    assert.doesNotMatch(result.output, /\[info\]/);
  } finally {
    await mock.close();
    await new Promise((resolve) => other.close(resolve));
  }
});

test('doctor passes a serving FreeToken as the default provider', async (t) => {
  const mock = await startMockFreeToken();
  const home = await seedDoctorHome(t, {
    providers: { ollama: { enabled: false }, freetoken: { enabled: true, baseUrl: `${mock.url}/private` } },
    defaults: { provider: 'freetoken', model: 'mock-model' },
  });
  try {
    const result = await runCli(['doctor'], { home });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /\[ok\] FreeToken — http:\/\/127\.0\.0\.1:\d+; FreeToken 0\.1\.2 · serving mock-model/);
    assert.match(result.output, /\[ok\] Default model availability — mock-model is available/);
    assert.match(result.output, /Result: ready\./);
    assert.doesNotMatch(result.output, /\/private/);
  } finally {
    await mock.close();
  }
});

test('doctor fails a loading FreeToken with a wait-and-retry next step', async (t) => {
  const mock = await startMockFreeToken({
    health: { status: 'loading', phase: 'weights', progress: { done_bytes: 42, total_bytes: 100 }, model: 'mock-model', instance_id: 'i-1' },
  });
  const home = await seedDoctorHome(t, {
    providers: { ollama: { enabled: false }, freetoken: { enabled: true, baseUrl: `${mock.url}/private` } },
    defaults: { provider: 'freetoken', model: 'mock-model' },
  });
  try {
    const result = await runCli(['doctor'], { home });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /\[fail\] FreeToken — .*still loading mock-model \(weights 42%\)/);
    assert.match(result.output, /Wait for FreeToken to finish \(check "ft ctl health"\), then run doctor again\./);
    assert.match(result.output, /Result: 1 failure\(s\)/);
    assert.doesNotMatch(result.output, /\/private/);
  } finally {
    await mock.close();
  }
});

test('doctor points a wrong default model at the id FreeToken actually serves', async (t) => {
  const mock = await startMockFreeToken();
  const home = await seedDoctorHome(t, {
    providers: { ollama: { enabled: false }, freetoken: { enabled: true, baseUrl: mock.url } },
    defaults: { provider: 'freetoken', model: 'other-model' },
  });
  try {
    const result = await runCli(['doctor'], { home });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /\[fail\] Default model availability — other-model was not returned by FreeToken/);
    assert.match(result.output, /FreeToken serves one model per process/);
  } finally {
    await mock.close();
  }
});

// ---- detection, and the first-run wizard that depends on it (issue #5) ----

// The gap this closes: /api/providers only health-checks providers that are
// already enabled, so an engine somebody started before opening SovereignAI
// was invisible until they found Settings on their own.
test('a running FreeToken engine is detected even though nobody enabled the provider', async () => {
  const mock = await startMockFreeToken();
  try {
    const found = await detectLocalFreeToken({ enabled: false, baseUrl: mock.url });
    assert.equal(found.ready, true);
    assert.equal(found.model, 'mock-model');
    assert.equal(found.url, mock.url, 'the URL comes back without a trailing slash');
    assert.match(found.detail, /FreeToken 0\.1\.2 · serving mock-model/, "the provider's own wording, not a second copy of it");
  } finally {
    await mock.close();
  }
});

test('detection reports a loading engine as running-but-not-ready, with the reason', async () => {
  const mock = await startMockFreeToken({
    health: { status: 'loading', model: 'mock-model', instance_id: 'i-2', phase: 'weights', progress: { done_bytes: 42, total_bytes: 100 } },
  });
  try {
    const found = await detectLocalFreeToken({ baseUrl: mock.url });
    assert.equal(found.ready, false, 'running, but you cannot chat with it yet');
    assert.equal(found.model, 'mock-model');
    assert.match(found.detail, /still loading mock-model \(weights 42%\)/, 'a wait is not a failure — say how far along it is');
  } finally {
    await mock.close();
  }
});

test('detection contacts loopback only, and never claims a stranger on the port is FreeToken', async () => {
  // A LAN or remote address is left alone: detection is a courtesy for the
  // engine on this machine, not a reason to poke someone else's host.
  let fetched = 0;
  await withFetch(async () => { fetched++; return jsonResponse(serving); }, async () => {
    assert.equal(await detectLocalFreeToken({ baseUrl: 'http://192.168.1.50:1919' }), null);
    assert.equal(await detectLocalFreeToken({ baseUrl: 'https://freetoken.example.com' }), null);
    assert.equal(fetched, 0, 'no socket is opened for an endpoint that is not on this machine');
  });

  // Something is listening on 1919, but it is not FreeToken.
  const impostor = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'something else entirely' }));
  });
  await new Promise((resolve) => impostor.listen(0, '127.0.0.1', resolve));
  try {
    assert.equal(await detectLocalFreeToken({ baseUrl: `http://127.0.0.1:${impostor.address().port}` }), null, 'no instance_id, no claim');
  } finally {
    await new Promise((resolve) => impostor.close(resolve));
  }

  assert.equal(await detectLocalFreeToken({ baseUrl: '' }), null);
  assert.equal(await detectLocalFreeToken(undefined), null);
  assert.equal(await detectLocalFreeToken({ baseUrl: 'http://127.0.0.1:1' }), null, 'a dead port is simply nothing');
});

test('GET /api/providers/freetoken/detect answers the wizard, and says so plainly when nothing runs', async () => {
  const mock = await startMockFreeToken();
  const running = await startTempApp({ providers: { freetoken: { enabled: false, baseUrl: mock.url } } });
  try {
    const res = await fetch(`${running.base}/api/providers/freetoken/detect`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ready, true);
    assert.equal(body.model, 'mock-model');

    // The provider row itself is unchanged: detection does not enable anything.
    const rows = await (await fetch(`${running.base}/api/providers`)).json();
    assert.equal(rows.find((row) => row.id === 'freetoken').enabled, false, 'finding an engine must never switch it on behind the user');
  } finally {
    await running.close();
    await mock.close();
  }

  const alone = await startTempApp({ providers: { freetoken: { enabled: false, baseUrl: 'http://127.0.0.1:1' } } });
  try {
    assert.deepEqual(await (await fetch(`${alone.base}/api/providers/freetoken/detect`)).json(), { running: false });
  } finally {
    await alone.close();
  }
});

test('the first-run wizard offers a detected FreeToken engine, and only a detected one', () => {
  const js = fs.readFileSync(path.join(repo, 'public', 'wizard.js'), 'utf8');
  const html = fs.readFileSync(path.join(repo, 'public', 'app.html'), 'utf8');

  // Hidden until something answers: an option nobody can take is noise.
  assert.match(html, /<div class="wz-choice" id="wz-choice-freetoken" hidden>/, 'the choice ships hidden');
  assert.match(html, /name="wz-provider" value="freetoken"/, 'and is a real radio in the same group');
  assert.match(html, /data-provider-fields="freetoken"/, 'so the shared field-group machinery shows and hides it');
  assert.match(js, /'freetoken', 'ollama'/, 'FreeToken leads the provider list: a local engine already serving is the best default');
  assert.match(js, /\/api\/providers\/freetoken\/detect/, 'the wizard asks the server, never the engine directly — the app CSP forbids the cross-origin call');

  // One model per process: reported, not chosen from a list.
  assert.match(js, /provider === 'freetoken'\) return \$\('#wz-freetoken-model'\)\?\.dataset\?\.model/, 'the model is whatever ft serve was started with');
  assert.match(js, /found\.ready && found\.model && !ollamaReady/, 'a working Ollama is never overridden — only an idle one is replaced');
  assert.match(js, /typeof res\.ready === 'boolean' && typeof res\.url === 'string'/, 'only a positive answer counts — an empty body must not become a phantom engine');
  assert.match(js, /providersUpdate\.freetoken = \{ enabled: true \}/, 'finishing setup switches the provider on');
  assert.match(js, /FreeToken did not report which model it is serving/, 'a blank model is explained where it can be fixed: the engine');

  // The honesty note the Settings card carries travels with the choice.
  assert.match(html + js, /no authentication/, 'the keyless-loopback caveat is stated in the wizard too');
  assert.match(js, /never leave this device|over loopback/, 'and where the traffic goes is stated in the wizard vocabulary');
});
