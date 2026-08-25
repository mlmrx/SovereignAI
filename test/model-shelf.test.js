import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { MODEL_SHELF, SHELF_CURATED_AT, shelfWithFit } from '../src/model-shelf.js';
import { autoExtractMemories } from '../src/memory-extract.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';

test('every shelf entry carries the honesty payload: license, why, size, hf pointer', () => {
  assert.match(SHELF_CURATED_AT, /^\d{4}-\d{2}$/, 'curation must be dated');
  assert.ok(MODEL_SHELF.length >= 5);
  for (const group of MODEL_SHELF) {
    assert.ok(group.role && group.label && group.job, `${group.role}: role metadata required`);
    assert.ok(group.models.length >= 1);
    for (const model of group.models) {
      assert.ok(model.base, `${group.role}: base required`);
      assert.ok(model.hf, `${model.base}: hf pointer required`);
      assert.ok(model.license, `${model.base}: weight license must be stated`);
      assert.ok(model.why, `${model.base}: curation without a reason is a leaderboard`);
      assert.ok(Number.isFinite(model.paramsB) && model.paramsB > 0, `${model.base}: paramsB required`);
    }
  }
  const cognition = MODEL_SHELF.find((group) => group.role === 'memory-cognition');
  assert.ok(cognition, 'the shelf must cover the cognition role — it is the product-specific reason small models matter');
});

test('shelfWithFit sizes against RAM and says nothing when it cannot know', () => {
  const sized = shelfWithFit({ totalMemoryBytes: 8 * 1024 ** 3, endpointLocal: true });
  assert.equal(sized.curatedAt, SHELF_CURATED_AT);
  const all = sized.roles.flatMap((group) => group.models);
  assert.ok(all.every((model) => ['fits', 'tight', 'too-big'].includes(model.fit)));
  const small = all.find((model) => model.paramsB <= 1.5);
  const big = all.find((model) => model.paramsB >= 12);
  assert.equal(small.fit, 'fits', 'a 1B-class model fits an 8GB machine');
  assert.equal(big.fit, 'too-big', 'a 12B model does not fit an 8GB machine');

  const remote = shelfWithFit({ totalMemoryBytes: 8 * 1024 ** 3, endpointLocal: false });
  assert.ok(remote.roles.flatMap((g) => g.models).every((model) => model.fit === null), 'remote endpoints must not be sized against this machine');
});

test('Qwen3.8-27B leads the reasoning group and is sized honestly: tight at 32 GB, comfortable at 48', () => {
  const reasoning = MODEL_SHELF.find((group) => group.role === 'reasoning');
  assert.equal(reasoning.models[0].base, 'qwen3.8:27b');
  assert.equal(reasoning.models[0].hf, 'Qwen/Qwen3.8-27B');
  assert.equal(reasoning.models[0].license, 'Apache-2.0');
  const pick = (gb) => shelfWithFit({ totalMemoryBytes: gb * 1024 ** 3, endpointLocal: true }).roles.find((group) => group.role === 'reasoning').models[0];
  assert.equal(pick(32).approxGBAtQ4, 16.2);
  assert.equal(pick(32).fit, 'tight', '16.2 GB against a 19.2 GB budget, over the 14.4 GB comfort line');
  assert.equal(pick(48).fit, 'fits', '16.2 GB against a 28.8 GB budget');
  assert.equal(pick(16).fit, 'too-big');
  assert.equal(pick(32).engine, 'ollama');
  assert.equal(pick(32).gpuFit, undefined, 'dense: no active-set rule');
});

test('the cognition shelf points at the official LFM2.5 GGUF repo in the hf.co/ form Ollama pulls', () => {
  const cognition = MODEL_SHELF.find((group) => group.role === 'memory-cognition');
  const lfm = cognition.models.find((model) => model.base.startsWith('hf.co/LiquidAI/'));
  assert.equal(lfm.base, 'hf.co/LiquidAI/LFM2.5-2.6B-GGUF');
  assert.equal(lfm.hf, 'LiquidAI/LFM2.5-2.6B-GGUF');
  assert.match(lfm.license, /LFM Open License v1\.0/);
  assert.match(lfm.license, /read it/i, 'a custom license says so on the shelf');
});

test('GET /api/model-shelf serves the sized shelf', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-shelf-'));
  fs.writeFileSync(path.join(dir, 'sovereign.config.json'), JSON.stringify({ embeddings: { provider: 'ollama', model: '' }, providers: { ollama: { enabled: false } } }));
  const app = createApp(dir, { env: {}, hardware: { detectGpu: async () => null } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    app.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/model-shelf`);
  assert.equal(res.status, 200);
  const shelf = await res.json();
  assert.equal(shelf.curatedAt, SHELF_CURATED_AT);
  assert.match(shelf.note, /not a leaderboard/i);
  assert.ok(shelf.roles.some((group) => group.role === 'memory-cognition'));
});

test('the cognition role owns memory-writing: extractionModel overrides the chat model', async (t) => {
  let requestedModel = null;
  const provider = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      requestedModel = JSON.parse(Buffer.concat(chunks).toString('utf8')).model;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"- Uses a tiny cognition model"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-cog-'));
  const store = openDb(dir);
  t.after(async () => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    await new Promise((resolve) => provider.close(resolve));
  });

  await autoExtractMemories({
    store,
    config: {
      defaults: { provider: 'openai', model: 'big-chat-model' },
      providers: { openai: { enabled: true, baseUrl: `http://127.0.0.1:${provider.address().port}` } },
      memory: { autoExtract: true, extractLocalOnly: false, extractionModel: 'tiny-cognition-model' },
    },
    providerId: 'openai',
    model: 'big-chat-model', // what the CHAT used — must not be what extraction uses
    userMessage: 'I use a small model for cognition.',
    assistantReply: 'Noted.',
  });

  assert.equal(requestedModel, 'tiny-cognition-model', 'extraction must run the dedicated cognition model');
  const memory = store.listMemories()[0];
  assert.equal(memory.author_model, 'tiny-cognition-model', 'the author receipt must name the model that actually wrote it');
});
