import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { provisionServeContainer, GpuProvisionError, DEFAULT_SERVE_IMAGE } from '../src/byoc/gpu-provision.js';
import { gpuProviders } from '../src/byoc/providers/index.js';
import { createApp } from '../src/server.js';

const instantSleep = () => Promise.resolve();

function withFakeGpuProvider(id, provider, fn) {
  const original = gpuProviders[id];
  gpuProviders[id] = provider;
  return fn().finally(() => {
    if (original) gpuProviders[id] = original;
    else delete gpuProviders[id];
  });
}

test('provisionServeContainer runs vLLM with the chosen weights and returns a hashed key', async () => {
  let provisionInput = null;
  const fake = {
    id: 'fakegpu',
    label: 'Fake GPU Cloud',
    computeStyle: 'container',
    async provision(input) {
      provisionInput = input;
      return { instanceId: 'pod-42' };
    },
    async getInstance({ port }) {
      assert.equal(port, 8000, 'readiness polling must look for the inference port, not 4321');
      return { instanceId: 'pod-42', status: 'running', host: '203.0.113.9', port: 30877 };
    },
  };

  const readiness = [];
  const fetchImpl = async (url, init) => {
    readiness.push({ url: String(url), auth: init?.headers?.authorization });
    if (readiness.length === 1) throw new Error('connection refused'); // still downloading weights
    return new Response(JSON.stringify({ data: [{ id: 'Qwen/Qwen3-32B' }] }), { status: 200 });
  };

  await withFakeGpuProvider('fakegpu', fake, async () => {
    const result = await provisionServeContainer({
      providerId: 'fakegpu',
      apiKey: 'provider-key',
      gpuTypeId: 'A100-80GB',
      name: 'serve',
      model: 'Qwen/Qwen3-32B',
      hfToken: 'hf_secret',
      sleep: instantSleep,
      fetchImpl,
    });

    assert.equal(provisionInput.port, 8000);
    assert.deepEqual(provisionInput.args, ['--model', 'Qwen/Qwen3-32B']);
    assert.equal(provisionInput.image, DEFAULT_SERVE_IMAGE);
    assert.ok(provisionInput.env.VLLM_API_KEY, 'the inference key must ride as instance env');
    assert.equal(provisionInput.env.HF_TOKEN, 'hf_secret', 'a gated-repo token must be forwarded when given');

    assert.equal(result.role, 'inference');
    assert.equal(result.host, '203.0.113.9');
    assert.equal(result.port, 30877);
    assert.deepEqual(result.models, ['Qwen/Qwen3-32B']);
    assert.equal(result.apiKeySha256, crypto.createHash('sha256').update(result.apiKey).digest('hex'));
    assert.match(readiness.at(-1).url, /203\.0\.113\.9:30877\/v1\/models/);
    assert.equal(readiness.at(-1).auth, `Bearer ${result.apiKey}`, 'readiness must authenticate with the generated key');
  });
});

test('provisionServeContainer refuses VM-style providers with a usable pointer', async () => {
  const fake = { id: 'fakevm', label: 'Fake VM Cloud', computeStyle: 'vm' };
  await withFakeGpuProvider('fakevm', fake, async () => {
    await assert.rejects(
      provisionServeContainer({ providerId: 'fakevm', apiKey: 'k', gpuTypeId: 'g', model: 'Qwen/Qwen3-32B' }),
      (err) => err instanceof GpuProvisionError && /container-style/.test(err.message) && /docker run/.test(err.message)
    );
  });
});

test('provisionServeContainer fails loudly when the inference server never becomes ready', async () => {
  const fake = {
    id: 'fakegpu2',
    label: 'Fake GPU Cloud',
    computeStyle: 'container',
    async provision() { return { instanceId: 'pod-1' }; },
    async getInstance() { return { instanceId: 'pod-1', status: 'running', host: '203.0.113.9', port: 30877 }; },
  };
  await withFakeGpuProvider('fakegpu2', fake, async () => {
    await assert.rejects(
      provisionServeContainer({
        providerId: 'fakegpu2', apiKey: 'k', gpuTypeId: 'g', model: 'big/model',
        sleep: instantSleep, readyTimeoutMs: 1,
        fetchImpl: async () => new Response('{}', { status: 503 }),
      }),
      (err) => err instanceof GpuProvisionError && /never became ready/.test(err.message) && /terminate/.test(err.message)
    );
  });
});

test('chat records the exact weights that answered: model digest flows to the message and the done event', async (t) => {
  const DIGEST = 'a'.repeat(64);
  const ollama = http.createServer((req, res) => {
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'llama3.1:latest', digest: `sha256:${DIGEST}` }] }));
      return;
    }
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end('{"message":{"content":"Hello there."},"done":false}\n{"done":true,"prompt_eval_count":5,"eval_count":3}\n');
    });
  });
  await new Promise((resolve) => ollama.listen(0, '127.0.0.1', resolve));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-digest-'));
  fs.writeFileSync(
    path.join(dir, 'sovereign.config.json'),
    JSON.stringify({
      embeddings: { provider: 'ollama', model: '' },
      defaults: { provider: 'ollama', model: 'llama3.1:latest' },
      providers: { ollama: { enabled: true, baseUrl: `http://127.0.0.1:${ollama.address().port}` } },
    })
  );
  const app = createApp(dir, { env: {}, hardware: { detectGpu: async () => null } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    app.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    await new Promise((resolve) => ollama.close(resolve));
  });

  const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'hi' }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, new RegExp(`"modelDigest":"${DIGEST}"`), 'the done event must carry the weight digest');

  const assistant = app.store.db.prepare("SELECT * FROM messages WHERE role = 'assistant'").get();
  assert.equal(assistant.model_digest, DIGEST, 'the persisted message must record which weights answered');
  assert.equal(assistant.model, 'llama3.1:latest');
});
