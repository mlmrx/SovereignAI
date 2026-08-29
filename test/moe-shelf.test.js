// Sparse (MoE) sizing: the shelf's frontier tier, the GPU probe behind it,
// and the routes that put both in front of the user. Every number here is
// derived from the same 0.6 GB/B at Q4 × 60%-usable rule the dense shelf uses;
// the sparse twist is that TOTAL params size against RAM while only the
// ACTIVE set sizes against VRAM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FIT_LABELS, MODEL_SHELF, effectiveEngine, shelfFit, shelfWithFit, sparseCandidates } from '../src/model-shelf.js';
import { buildModelRecommendation, estimateSparseFit } from '../src/model-recommendation.js';
import { createGpuProbe, parseNvidiaSmi } from '../src/hardware.js';
import { createApp } from '../src/server.js';

const GB = 1024 ** 3;
const LOCAL = { freetoken: { enabled: false, local: true } };
const QWEN = 'Qwen/Qwen3.6-35B-A3B';
const GPT_OSS_20B = 'openai/gpt-oss-20b';
const GEMMA = 'google/gemma-4-26B-A4B-it';
const GPT_OSS_120B = 'openai/gpt-oss-120b';
// The one sparse entry Ollama pulls directly: its base is an Ollama tag, and it overrides the tier's engine.
const NEMOTRON = 'nemotron-3.5-lightning:30b';

const moeGroup = (shelf) => shelf.roles.find((group) => group.role === 'frontier-moe');
const byBase = (models) => Object.fromEntries(models.map((model) => [model.base, model]));
const dense = (shelf) => shelf.roles.filter((group) => group.role !== 'frontier-moe').flatMap((group) => group.models);
// Works on the raw tier (engine inherited from the group) and on the sized output (engine populated).
const servedBy = (group, engine) => group.models.filter((model) => effectiveEngine(model, group) === engine);

// ---------------------------------------------------------------- shelf data

test('the frontier MoE tier is last, served by FreeToken, and every entry is an honest sparse model', () => {
  const group = MODEL_SHELF.at(-1);
  assert.equal(group.role, 'frontier-moe', 'the MoE tier must be appended after the dense roles');
  assert.equal(group.engine, 'freetoken');
  assert.ok(group.models.length >= 4);
  for (const model of group.models) {
    assert.equal(model.architecture, 'moe', `${model.base}: architecture`);
    assert.ok(Number.isFinite(model.activeParamsB) && model.activeParamsB > 0, `${model.base}: activeParamsB`);
    assert.ok(model.activeParamsB < model.paramsB, `${model.base}: the active set is a subset of the total`);
    assert.ok(model.license && model.why, `${model.base}: license and why`);
    if (effectiveEngine(model, group) === 'freetoken') assert.equal(model.hf, model.base, `${model.base}: base is the Hugging Face id ft serve takes`);
  }
  // One entry overrides the group's engine: Ollama pulls its GGUF directly, so
  // its base is an Ollama library tag and its hf pointer is the upstream repo.
  const nemotron = group.models.find((m) => m.base === NEMOTRON);
  assert.equal(nemotron.engine, 'ollama');
  assert.equal(effectiveEngine(nemotron, group), 'ollama', 'the entry’s own engine wins over the group’s');
  assert.match(nemotron.base, /^[a-z0-9.-]+:[a-z0-9]+$/, 'an Ollama library tag, not a Hugging Face id');
  assert.equal(nemotron.hf, 'nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16');
  assert.equal(group.models.indexOf(nemotron), group.models.findIndex((m) => m.base === GPT_OSS_120B) - 1, 'after gemma-4, before gpt-oss-120b');
  assert.ok(servedBy(group, 'freetoken').length >= 4, 'the FreeToken-served tier keeps its four');
  assert.deepEqual(
    sparseCandidates().map((c) => c.base),
    servedBy(group, 'freetoken').map((m) => m.base),
    'sparseCandidates mirrors the FreeToken-served entries of the tier'
  );
  assert.ok(!sparseCandidates().some((c) => c.base === NEMOTRON), 'FreeToken’s model list does not name Nemotron, so ft serve is not claimed for it');
  assert.ok(sparseCandidates().every((c) => Object.keys(c).sort().join() === 'activeParamsB,base,paramsB'));
});

// ---------------------------------------------------------------- RAM fit (total params)

test('sparse entries size their TOTAL params against RAM, exactly like dense entries', () => {
  const at8 = byBase(moeGroup(shelfWithFit({ totalMemoryBytes: 8 * GB, endpointLocal: true, engines: LOCAL })).models);
  for (const base of [QWEN, GPT_OSS_20B, GEMMA, NEMOTRON, GPT_OSS_120B]) assert.equal(at8[base].fit, 'too-big', `${base} at 8 GB`);

  const at32 = byBase(moeGroup(shelfWithFit({ totalMemoryBytes: 32 * GB, endpointLocal: true, engines: LOCAL })).models);
  assert.equal(at32[QWEN].approxGBAtQ4, 21);
  assert.equal(at32[QWEN].fit, 'too-big', '21 GB against a 19.2 GB budget');
  assert.equal(at32[GPT_OSS_20B].approxGBAtQ4, 12.6);
  assert.equal(at32[GPT_OSS_20B].fit, 'fits');
  assert.equal(at32[GEMMA].approxGBAtQ4, 15.1);
  assert.equal(at32[GEMMA].fit, 'tight');
  assert.equal(at32[GPT_OSS_120B].approxGBAtQ4, 70.2);
  assert.equal(at32[GPT_OSS_120B].fit, 'too-big');
  assert.equal(at32[NEMOTRON].approxGBAtQ4, 18, '30B total × 0.6 — the whole weight set, since Ollama keeps it resident');
  assert.equal(at32[NEMOTRON].fit, 'tight', '18 GB against a 19.2 GB budget, over the 14.4 GB comfort line');

  const at48 = byBase(moeGroup(shelfWithFit({ totalMemoryBytes: 48 * GB, endpointLocal: true, engines: LOCAL })).models);
  assert.equal(at48[NEMOTRON].fit, 'fits', '18 GB against a 28.8 GB budget');

  const at128 = byBase(moeGroup(shelfWithFit({ totalMemoryBytes: 128 * GB, endpointLocal: true, engines: LOCAL })).models);
  assert.equal(at128[QWEN].fit, 'fits');
  assert.equal(at128[GPT_OSS_120B].fit, 'tight', '70.2 GB against a 76.8 GB budget');
});

test('sparse entries carry the active-set numbers; dense entries stay dense', () => {
  const shelf = shelfWithFit({ totalMemoryBytes: 32 * GB, endpointLocal: true });
  const moe = byBase(moeGroup(shelf).models);
  assert.equal(moe[QWEN].activeParamsB, 3);
  assert.equal(moe[QWEN].approxActiveGBAtQ4, 1.8);
  assert.equal(moe[QWEN].engine, 'freetoken');
  assert.equal(moe[QWEN].architecture, 'moe');
  assert.equal(moe[NEMOTRON].activeParamsB, 3);
  assert.equal(moe[NEMOTRON].approxActiveGBAtQ4, 1.8);
  assert.equal(moe[NEMOTRON].engine, 'ollama', 'the API row carries the effective engine, not the group’s');
  assert.equal(moe[NEMOTRON].architecture, 'moe');
  for (const model of dense(shelf)) {
    assert.equal(model.architecture, 'dense');
    assert.equal(model.engine, 'ollama');
    assert.equal(model.gpuFit, undefined, 'dense entries never carry gpuFit');
    assert.equal(model.engineEnabled, null, 'no engines passed → Ollama entries say nothing about enablement');
  }
});

// ---------------------------------------------------------------- locality gate

test('each entry is sized against this machine only when ITS engine is local', () => {
  const gpu = { vramBytes: 8 * GB, name: 'Fake GPU', unifiedMemory: false, source: 'nvidia-smi' };
  const ollamaLocalOnly = shelfWithFit({ totalMemoryBytes: 32 * GB, endpointLocal: true, engines: { freetoken: { enabled: true, local: false } }, gpu });
  assert.ok(servedBy(moeGroup(ollamaLocalOnly), 'freetoken').every((m) => m.fit === null), 'a remote FreeToken is not sized against this RAM');
  assert.ok(servedBy(moeGroup(ollamaLocalOnly), 'freetoken').every((m) => m.gpuFit === null), 'a remote FreeToken is not sized against this GPU either');
  const nemotronHome = byBase(moeGroup(ollamaLocalOnly).models)[NEMOTRON];
  assert.equal(nemotronHome.fit, 'tight', 'the Ollama-served sparse entry follows the Ollama gate, not FreeToken’s');
  assert.equal(nemotronHome.gpuFit, null, 'and never carries gpuFit, even with a GPU in hand');
  assert.ok(dense(ollamaLocalOnly).every((m) => ['fits', 'tight', 'too-big'].includes(m.fit)), 'dense entries keep the Ollama locality');

  const freetokenLocalOnly = shelfWithFit({ totalMemoryBytes: 32 * GB, endpointLocal: false, engines: { freetoken: { enabled: true, local: true } }, gpu });
  assert.ok(dense(freetokenLocalOnly).every((m) => m.fit === null));
  assert.ok(servedBy(moeGroup(freetokenLocalOnly), 'freetoken').every((m) => ['fits', 'tight', 'too-big'].includes(m.fit)));
  assert.ok(servedBy(moeGroup(freetokenLocalOnly), 'freetoken').every((m) => ['fits', 'tight', 'too-big'].includes(m.gpuFit)));
  const nemotronAway = byBase(moeGroup(freetokenLocalOnly).models)[NEMOTRON];
  assert.equal(nemotronAway.fit, null, 'a remote Ollama means the Ollama-served sparse entry is not sized here, whatever FreeToken is doing');
  assert.equal(nemotronAway.gpuFit, null);

  const noEngines = shelfWithFit({ totalMemoryBytes: 32 * GB, endpointLocal: false });
  assert.ok(moeGroup(noEngines).models.every((m) => m.fit === null), 'unknown engines fall back to endpointLocal');
});

test('engineEnabled reflects the engine row: true, false, or null when unknown', () => {
  const on = moeGroup(shelfWithFit({ totalMemoryBytes: 32 * GB, endpointLocal: true, engines: { freetoken: { enabled: true, local: true } } })).models[0];
  const off = moeGroup(shelfWithFit({ totalMemoryBytes: 32 * GB, endpointLocal: true, engines: LOCAL })).models[0];
  const unknown = moeGroup(shelfWithFit({ totalMemoryBytes: 32 * GB, endpointLocal: true })).models[0];
  assert.equal(on.engineEnabled, true);
  assert.equal(off.engineEnabled, false);
  assert.equal(unknown.engineEnabled, null);
  const ollama = shelfWithFit({ totalMemoryBytes: 32 * GB, endpointLocal: true, engines: { ollama: { enabled: true, local: true } } }).roles[0].models[0];
  assert.equal(ollama.engineEnabled, true, 'Ollama entries read engines.ollama when it is passed');
  const sparseOllama = byBase(moeGroup(shelfWithFit({ totalMemoryBytes: 32 * GB, endpointLocal: true, engines: { freetoken: { enabled: true, local: true } } })).models)[NEMOTRON];
  assert.equal(sparseOllama.engineEnabled, null, 'an Ollama-served sparse entry reads engines.ollama, not engines.freetoken');
  const sparseOllamaOn = byBase(moeGroup(shelfWithFit({ totalMemoryBytes: 32 * GB, endpointLocal: true, engines: { freetoken: { enabled: false, local: true }, ollama: { enabled: true, local: true } } })).models)[NEMOTRON];
  assert.equal(sparseOllamaOn.engineEnabled, true);
});

// ---------------------------------------------------------------- GPU fit (active params)

test('gpuFit sizes the ACTIVE set against 60% of dedicated VRAM, on sparse entries only', () => {
  const gpu4 = { vramBytes: 4 * GB, name: 'NVIDIA GeForce RTX 3050 Ti Laptop GPU', unifiedMemory: false, source: 'nvidia-smi' };
  const at4 = shelfWithFit({ totalMemoryBytes: 32 * GB, endpointLocal: true, engines: LOCAL, gpu: gpu4 });
  const moe4 = byBase(moeGroup(at4).models);
  assert.equal(moe4[QWEN].gpuFit, 'fits', '1.8 GB active against a 2.4 GB VRAM budget (0.75 × 2.4 = 1.8)');
  assert.equal(moe4[GPT_OSS_20B].gpuFit, 'tight', '2.2 GB');
  assert.equal(moe4[GPT_OSS_120B].gpuFit, 'too-big', '3.1 GB');
  assert.equal(moe4[NEMOTRON].gpuFit, null, 'Ollama keeps the whole weight set resident: no active-set VRAM rule, even though 1.8 GB would clear it');
  assert.ok(dense(at4).every((m) => m.gpuFit === undefined));
  assert.deepEqual(at4.gpu, { vramGB: 4, name: gpu4.name, unifiedMemory: false, source: 'nvidia-smi' });

  const at24 = shelfWithFit({ totalMemoryBytes: 64 * GB, endpointLocal: true, engines: LOCAL, gpu: { ...gpu4, vramBytes: 24 * GB } });
  assert.ok(servedBy(moeGroup(at24), 'freetoken').every((m) => m.gpuFit === 'fits'));
  assert.equal(byBase(moeGroup(at24).models)[NEMOTRON].gpuFit, null);

  const unknownVram = shelfWithFit({ totalMemoryBytes: 64 * GB, endpointLocal: true, engines: LOCAL, gpu: { vramBytes: null, name: null, unifiedMemory: false, source: null } });
  assert.ok(moeGroup(unknownVram).models.every((m) => m.gpuFit === null));
  assert.deepEqual(unknownVram.gpu, { vramGB: null, name: null, unifiedMemory: false, source: null });

  const unified = shelfWithFit({ totalMemoryBytes: 64 * GB, endpointLocal: true, engines: LOCAL, gpu: { vramBytes: 64 * GB, name: 'Apple Silicon (unified memory)', unifiedMemory: true, source: 'unified' } });
  assert.ok(moeGroup(unified).models.every((m) => m.gpuFit === null), 'unified memory: the RAM rule is the GPU rule');
  assert.ok(moeGroup(unified).models.every((m) => m.fit !== null));

  assert.equal(shelfWithFit({ totalMemoryBytes: 64 * GB, endpointLocal: true }).gpu, null, 'no probe result → no gpu block');
});

// ---------------------------------------------------------------- estimateSparseFit

test('estimateSparseFit picks the largest sparse model that clears BOTH the RAM and the VRAM rule', () => {
  const candidates = sparseCandidates();

  // 32 GB RAM: Qwen (21 GB) fails the RAM rule; a 4 GB GPU (2.4 GB budget)
  // still admits gemma's 2.3 GB active set, so gemma (25.2B) is the largest fit.
  const laptop = estimateSparseFit({ totalMemoryBytes: 32 * GB, vramBytes: 4 * GB, engineLocal: true, candidates });
  assert.equal(laptop.applies, true);
  assert.deepEqual(laptop.largest, { base: GEMMA, paramsB: 25.2, activeParamsB: 3.8 });
  assert.match(laptop.reasoning, /gemma-4-26B-A4B-it \(25\.2B total\)/);
  assert.match(laptop.reasoning, /32 GB of RAM/);
  assert.match(laptop.reasoning, /4 GB GPU/);
  assert.doesNotMatch(laptop.reasoning, /could not be read/);

  // A slightly smaller GPU (3.7 GB → 2.2 GB budget) cuts gemma (2.3 GB active) out: gpt-oss-20b (2.2 GB) is next.
  const smallerGpu = estimateSparseFit({ totalMemoryBytes: 32 * GB, vramBytes: 3.7 * GB, engineLocal: true, candidates });
  assert.equal(smallerGpu.largest.base, GPT_OSS_20B);
  assert.match(smallerGpu.reasoning, /gpt-oss-20b/);

  // 64 GB RAM + 24 GB VRAM: gpt-oss-120b (70.2 GB) still fails RAM → Qwen 35B.
  const desktop = estimateSparseFit({ totalMemoryBytes: 64 * GB, vramBytes: 24 * GB, engineLocal: true, candidates });
  assert.equal(desktop.largest.base, QWEN);
  assert.equal(desktop.largest.paramsB, 35);
  assert.match(desktop.reasoning, /Qwen\/Qwen3\.6-35B-A3B \(35B total\)/);
});

test('estimateSparseFit is honest when nothing fits, when the engine is remote, and when VRAM is unknown', () => {
  const candidates = sparseCandidates();

  const tiny = estimateSparseFit({ totalMemoryBytes: 8 * GB, vramBytes: 4 * GB, engineLocal: true, candidates });
  assert.equal(tiny.applies, true);
  assert.equal(tiny.largest, null);
  assert.match(tiny.reasoning, /smallest on the shelf needs about 12\.6 GB/);

  const gpuTooSmall = estimateSparseFit({ totalMemoryBytes: 32 * GB, vramBytes: 2 * GB, engineLocal: true, candidates });
  assert.equal(gpuTooSmall.largest, null);
  assert.match(gpuTooSmall.reasoning, /2 GB of GPU memory is too small/);

  const remote = estimateSparseFit({ totalMemoryBytes: 64 * GB, vramBytes: 24 * GB, engineLocal: false, candidates });
  assert.equal(remote.applies, false);
  assert.equal(remote.largest, null);
  assert.match(remote.reasoning, /not on this device/);

  assert.equal(estimateSparseFit({ totalMemoryBytes: NaN, engineLocal: true, candidates }).applies, false);

  const noVram = estimateSparseFit({ totalMemoryBytes: 64 * GB, vramBytes: null, engineLocal: true, candidates });
  assert.equal(noVram.largest.base, QWEN);
  assert.match(noVram.reasoning, /could not be read/);

  const unified = estimateSparseFit({ totalMemoryBytes: 64 * GB, vramBytes: 64 * GB, unifiedMemory: true, engineLocal: true, candidates });
  assert.equal(unified.largest, null, 'FreeToken has no Apple Silicon backend yet, so nothing is recommended');
  assert.match(unified.reasoning, /Apple Silicon/, 'unified memory says why the sparse tier is not sized here');
  assert.doesNotMatch(unified.reasoning, /could not be read/);
});

test('buildModelRecommendation keeps its original shape and adds gpu + sparseFit', () => {
  const gpu = { vramBytes: 8 * GB, name: 'Fake GPU', unifiedMemory: false, source: 'nvidia-smi' };
  const args = { totalMemoryBytes: 16 * GB, endpointLocal: true, corpus: { documents: 0, totalDocumentChars: 0, memories: 0 }, maxTrainCount: 0 };

  const full = buildModelRecommendation({ ...args, gpu, sparse: { engineLocal: true, candidates: sparseCandidates() } });
  assert.deepEqual(full.hardware, { totalMemoryGB: 16 }, 'hardware must not grow keys');
  assert.equal(full.modelFit.label, '~14B at Q4_K_M');
  assert.deepEqual(full.gpu, { vramGB: 8, name: 'Fake GPU', unifiedMemory: false, source: 'nvidia-smi' });
  assert.equal(full.sparseFit.applies, true);
  assert.equal(full.sparseFit.largest, null, '16 GB reserves 9.6 GB; the smallest sparse model needs 12.6');

  const bare = buildModelRecommendation(args);
  assert.equal(bare.gpu, null);
  assert.equal(bare.sparseFit, null);
  assert.deepEqual(bare.hardware, { totalMemoryGB: 16 });
});

// ---------------------------------------------------------------- hardware probe

function fakeSpawn({ stdout = '', code = 0, error = null, neverCloses = false } = {}) {
  const calls = [];
  const spawn = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => { child.killed = true; };
    setImmediate(() => {
      if (error) return child.emit('error', Object.assign(new Error(error), { code: error }));
      if (neverCloses) return;
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', code);
    });
    return child;
  };
  return { spawn, calls };
}

const noSysfs = { readdir: async () => { throw new Error('ENOENT'); }, readFile: async () => { throw new Error('ENOENT'); } };

test('parseNvidiaSmi reads "name, MiB" lines and keeps the largest adapter', () => {
  assert.deepEqual(parseNvidiaSmi('NVIDIA GeForce RTX 3050 Ti Laptop GPU, 4096\n'), { vramBytes: 4096 * 2 ** 20, name: 'NVIDIA GeForce RTX 3050 Ti Laptop GPU' });
  assert.deepEqual(parseNvidiaSmi('NVIDIA T400, 2048\r\nNVIDIA GeForce RTX 4090, 24564\r\n').name, 'NVIDIA GeForce RTX 4090');
  assert.equal(parseNvidiaSmi('No devices were found'), null);
  assert.equal(parseNvidiaSmi(''), null);
});

test('detectGpu: nvidia-smi output becomes bytes, the larger of two adapters wins', async () => {
  const one = fakeSpawn({ stdout: 'NVIDIA GeForce RTX 3050 Ti Laptop GPU, 4096\n' });
  const gpu = await createGpuProbe({ platform: 'win32', arch: 'x64', env: {}, spawn: one.spawn, ...noSysfs })();
  assert.deepEqual(gpu, { vramBytes: 4096 * 2 ** 20, name: 'NVIDIA GeForce RTX 3050 Ti Laptop GPU', unifiedMemory: false, source: 'nvidia-smi' });
  assert.equal(one.calls[0].cmd, 'nvidia-smi');
  assert.deepEqual(one.calls[0].args, ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
  assert.equal(one.calls[0].options.windowsHide, true);

  const two = fakeSpawn({ stdout: 'NVIDIA T400, 2048\nNVIDIA GeForce RTX 4090, 24564\n' });
  const big = await createGpuProbe({ platform: 'linux', arch: 'x64', env: {}, spawn: two.spawn, ...noSysfs })();
  assert.equal(big.name, 'NVIDIA GeForce RTX 4090');
  assert.equal(big.vramBytes, 24564 * 2 ** 20);
});

test('detectGpu: no nvidia-smi falls through to sysfs on linux and to nulls elsewhere', async () => {
  const missing = fakeSpawn({ error: 'ENOENT' });
  const sysfs = {
    readdir: async (dir) => { assert.equal(dir, '/sys/class/drm'); return ['card0', 'card0-DP-1', 'card1', 'renderD128']; },
    readFile: async (file) => (file.includes('card1') ? '17163091968\n' : '536870912\n'),
  };
  const linux = await createGpuProbe({ platform: 'linux', arch: 'x64', env: {}, spawn: missing.spawn, ...sysfs })();
  assert.deepEqual(linux, { vramBytes: 17163091968, name: null, unifiedMemory: false, source: 'sysfs' });

  const windows = await createGpuProbe({ platform: 'win32', arch: 'x64', env: {}, spawn: fakeSpawn({ error: 'ENOENT' }).spawn, ...sysfs })();
  assert.deepEqual(windows, { vramBytes: null, name: null, unifiedMemory: false, source: null });

  const garbage = await createGpuProbe({ platform: 'win32', arch: 'x64', env: {}, spawn: fakeSpawn({ stdout: 'NVIDIA-SMI has failed', code: 9 }).spawn, ...noSysfs })();
  assert.deepEqual(garbage, { vramBytes: null, name: null, unifiedMemory: false, source: null });

  const throwing = await createGpuProbe({ platform: 'win32', arch: 'x64', env: {}, spawn: () => { throw new Error('spawn EACCES'); }, ...noSysfs })();
  assert.equal(throwing.source, null);
});

test('detectGpu: a hung nvidia-smi is killed at the timeout and reported as unknown', async () => {
  const hung = fakeSpawn({ neverCloses: true });
  const started = Date.now();
  const gpu = await createGpuProbe({ platform: 'win32', arch: 'x64', env: {}, spawn: hung.spawn, timeoutMs: 50, ...noSysfs })();
  assert.ok(Date.now() - started < 1000, 'resolves promptly after the timeout');
  assert.deepEqual(gpu, { vramBytes: null, name: null, unifiedMemory: false, source: null });
});

test('detectGpu: the opt-out and Apple Silicon short-circuit without spawning; the result is memoized', async () => {
  const off = fakeSpawn();
  const disabled = await createGpuProbe({ platform: 'linux', arch: 'x64', env: { SOVEREIGN_HARDWARE_PROBE: 'off' }, spawn: off.spawn })();
  assert.deepEqual(disabled, { vramBytes: null, name: null, unifiedMemory: false, source: 'disabled' });
  assert.equal(off.calls.length, 0);

  const mac = fakeSpawn();
  const apple = await createGpuProbe({ platform: 'darwin', arch: 'arm64', env: {}, spawn: mac.spawn })();
  assert.deepEqual(apple, { vramBytes: null, name: 'Apple Silicon (unified memory)', unifiedMemory: true, source: 'unified' });
  assert.equal(mac.calls.length, 0);

  const once = fakeSpawn({ stdout: 'NVIDIA GeForce RTX 4060, 8188\n' });
  const detect = createGpuProbe({ platform: 'win32', arch: 'x64', env: {}, spawn: once.spawn, ...noSysfs });
  const [first, second] = await Promise.all([detect(), detect()]);
  const third = await detect();
  assert.equal(first, second);
  assert.equal(second, third);
  assert.equal(once.calls.length, 1, 'one probe per process');
});

// ---------------------------------------------------------------- routes

async function startTempApp(config = {}, { env = {}, hardware } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-moe-'));
  fs.writeFileSync(path.join(root, 'sovereign.config.json'), JSON.stringify(config));
  const instance = createApp(root, { env, hardware });
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

const HERMETIC = { embeddings: { provider: 'ollama', model: '' }, providers: { ollama: { enabled: false } } };
const fakeGpu = { vramBytes: 8 * GB, name: 'Fake GPU', unifiedMemory: false, source: 'nvidia-smi' };

test('GET /api/model-shelf and /api/model-recommendation carry the injected GPU and the sparse tier', async (t) => {
  let probes = 0;
  const server = await startTempApp(HERMETIC, { hardware: { detectGpu: async () => { probes++; return fakeGpu; } } });
  t.after(() => server.close());

  const shelfRes = await fetch(`${server.base}/api/model-shelf`);
  assert.equal(shelfRes.status, 200);
  const shelf = await shelfRes.json();
  assert.deepEqual(shelf.gpu, { vramGB: 8, name: 'Fake GPU', unifiedMemory: false, source: 'nvidia-smi' });
  const group = shelf.roles.at(-1);
  assert.equal(group.role, 'frontier-moe');
  for (const model of servedBy(group, 'freetoken')) {
    assert.ok(['fits', 'tight', 'too-big'].includes(model.gpuFit), `${model.base}: gpuFit from the 8 GB fake`);
    assert.equal(model.engineEnabled, false, 'freetoken is absent from this config → not enabled');
    assert.equal(model.engine, 'freetoken');
    assert.ok(Number.isFinite(model.approxActiveGBAtQ4));
  }
  // The API row's `engine` is the effective one, and Ollama's rules apply to that row.
  const nemotron = byBase(group.models)[NEMOTRON];
  assert.equal(nemotron.engine, 'ollama');
  assert.equal(nemotron.gpuFit, null, 'no active-set VRAM rule under Ollama, GPU or not');
  assert.equal(nemotron.engineEnabled, null, 'the route passes no Ollama engine row, so enablement is not claimed');
  assert.ok(['fits', 'tight', 'too-big'].includes(nemotron.fit), 'the default Ollama URL is loopback, so the RAM rule applies');
  assert.ok(Number.isFinite(nemotron.approxActiveGBAtQ4));
  assert.ok(probes >= 1, 'the injected probe was used');

  const recRes = await fetch(`${server.base}/api/model-recommendation`);
  assert.equal(recRes.status, 200);
  const rec = await recRes.json();
  assert.match(rec.modelFit.label, /^~\d+B at Q4_K_M$/, 'the dense recommendation is untouched');
  assert.equal(typeof rec.hardware.totalMemoryGB, 'number');
  assert.deepEqual(Object.keys(rec.hardware), ['totalMemoryGB']);
  assert.deepEqual(rec.gpu, { vramGB: 8, name: 'Fake GPU', unifiedMemory: false, source: 'nvidia-smi' });
  assert.equal(rec.sparseFit.applies, true, 'the default FreeToken URL is loopback');
  assert.equal(typeof rec.sparseFit.reasoning, 'string');
  assert.ok(rec.sparseFit.largest === null || typeof rec.sparseFit.largest.base === 'string');
});

test('the routes stay 200 when the probe finds nothing or fails outright', async (t) => {
  const nothing = await startTempApp(HERMETIC, { hardware: { detectGpu: async () => null } });
  t.after(() => nothing.close());
  const shelf = await (await fetch(`${nothing.base}/api/model-shelf`)).json();
  assert.equal(shelf.gpu, null);
  assert.ok(shelf.roles.at(-1).models.every((m) => m.gpuFit === null));
  const rec = await (await fetch(`${nothing.base}/api/model-recommendation`)).json();
  assert.equal(rec.gpu, null);
  assert.match(rec.sparseFit.reasoning, /could not be read|not on this device|reserves less/);

  const broken = await startTempApp(HERMETIC, { hardware: { detectGpu: async () => { throw new Error('probe exploded'); } } });
  t.after(() => broken.close());
  const res = await fetch(`${broken.base}/api/model-shelf`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).gpu, null);
});

test('a remote FreeToken endpoint is not sized against this machine, even when Ollama is local', async (t) => {
  const config = { ...HERMETIC, providers: { ollama: { enabled: false, baseUrl: 'http://localhost:11434' }, freetoken: { enabled: true, baseUrl: 'http://10.0.0.7:1919' } } };
  let server;
  try {
    server = await startTempApp(config, { hardware: { detectGpu: async () => fakeGpu } });
  } catch (error) {
    // The freetoken provider lands in config.js separately; until it does, the
    // key is rejected and this route-level check has nothing to exercise.
    if (error.name === 'ConfigValidationError') return t.skip('config.js does not accept providers.freetoken yet');
    throw error;
  }
  t.after(() => server.close());
  const shelf = await (await fetch(`${server.base}/api/model-shelf`)).json();
  const group = shelf.roles.at(-1);
  const remoteRows = servedBy(group, 'freetoken');
  assert.ok(remoteRows.every((m) => m.engineEnabled === true));
  assert.ok(remoteRows.every((m) => m.fit === null), 'remote engine → fit null');
  assert.ok(remoteRows.every((m) => m.gpuFit === null), 'remote engine → gpuFit null despite the injected GPU');
  const nemotron = byBase(group.models)[NEMOTRON];
  assert.ok(['fits', 'tight', 'too-big'].includes(nemotron.fit), 'the Ollama-served sparse entry follows the local Ollama, not the remote FreeToken');
  assert.equal(nemotron.gpuFit, null);
  assert.ok(shelf.roles[0].models.every((m) => m.fit !== null), 'dense entries still size against local Ollama');
  const rec = await (await fetch(`${server.base}/api/model-recommendation`)).json();
  assert.equal(rec.sparseFit.applies, false);
  assert.match(rec.sparseFit.reasoning, /not on this device/);
});


test('estimateSparseFit names the rule that actually blocks when nothing fits', () => {
  const candidates = sparseCandidates();
  // 32 GB RAM admits gpt-oss-20b and gemma; a 3 GB GPU (1.8 GB budget) admits only Qwen's
  // 1.8 GB active set, which RAM rejects — nothing clears both, and neither rule alone is "the" block.
  const mixed = estimateSparseFit({ totalMemoryBytes: 32 * GB, vramBytes: 3 * GB, engineLocal: true, candidates });
  assert.equal(mixed.largest, null);
  assert.match(mixed.reasoning, /clears both rules/);
  assert.doesNotMatch(mixed.reasoning, /too small for even the smallest active set/);
  // A 1 GB GPU (0.6 GB budget) admits no active set at all: the GPU sentence is true.
  const gpuBlocked = estimateSparseFit({ totalMemoryBytes: 32 * GB, vramBytes: 1 * GB, engineLocal: true, candidates });
  assert.equal(gpuBlocked.largest, null);
  assert.match(gpuBlocked.reasoning, /too small for even the smallest active set/);
  // 8 GB RAM blocks before the GPU is even consulted.
  const ramBlocked = estimateSparseFit({ totalMemoryBytes: 8 * GB, vramBytes: 24 * GB, engineLocal: true, candidates });
  assert.match(ramBlocked.reasoning, /full weights in RAM/);
});

test('detectGpu re-probes an unknown result after the retry window, but keeps a definitive one', async () => {
  const { EventEmitter } = await import('node:events');
  const child = (exitCode, stdout = '') => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    setImmediate(() => {
      if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
      proc.emit('close', exitCode);
    });
    return proc;
  };
  let clock = 0;
  let failures = 0;
  const flaky = createGpuProbe({ platform: 'win32', arch: 'x64', env: {}, now: () => clock, spawn: () => { failures++; return child(1); } });
  assert.equal((await flaky()).source, null);
  await flaky();
  assert.equal(failures, 1, 'inside the window the unknown result is reused');
  clock = 61_000;
  await flaky();
  assert.equal(failures, 2, 'after the window an unknown result is probed again');

  let successes = 0;
  const steady = createGpuProbe({ platform: 'win32', arch: 'x64', env: {}, now: () => clock, spawn: () => { successes++; return child(0, 'Fake GPU, 8192\n'); } });
  assert.equal((await steady()).vramBytes, 8192 * 2 ** 20);
  clock = 10_000_000;
  await steady();
  assert.equal(successes, 1, 'a real GPU is never re-probed');
});

// `shelfFit` answers a different question from `shelfWithFit`: not "what on
// the shelf fits this machine" but "does the model this person already
// configured fit it" — the question `sovereign doctor` asks (issue #11).
test('shelfFit sizes a configured model id, in the shelf badge’s own words', () => {
  const RAM32 = 32 * GB;
  const fit = shelfFit('qwen3.8:27b', { totalMemoryBytes: RAM32 });
  assert.equal(fit.needGB, 16.2, '27B × 0.6 GB/B at Q4');
  assert.equal(fit.budgetGB, 19.2, '60% of 32 GB is the usable budget');
  assert.equal(fit.fit, 'tight');
  assert.equal(fit.label, FIT_LABELS.tight);
  assert.equal(fit.engine, 'ollama');

  // The id arrives in whichever dialect the user's engine speaks.
  assert.equal(shelfFit('QWEN3.8:27B', { totalMemoryBytes: RAM32 })?.base, 'qwen3.8:27b', 'case is not identity');
  assert.equal(shelfFit('qwen3.8:27b:latest', { totalMemoryBytes: RAM32 })?.base, 'qwen3.8:27b', "Ollama's :latest suffix");
  assert.equal(shelfFit('Qwen/Qwen3.8-27B', { totalMemoryBytes: RAM32 })?.base, 'qwen3.8:27b', 'the Hugging Face id finds the same entry');
  assert.equal(shelfFit('LiquidAI/LFM2.5-2.6B-GGUF', { totalMemoryBytes: RAM32 })?.needGB, 1.6, 'the hf.co/ prefix is not part of the name');
  assert.equal(shelfFit(QWEN, { totalMemoryBytes: RAM32 })?.architecture, 'moe', 'a sparse entry sizes on TOTAL params, as it must');

  // Unknown stays unknown: no parameter count, no claim.
  assert.equal(shelfFit('someone/private-finetune', { totalMemoryBytes: RAM32 }), null);
  assert.equal(shelfFit('', { totalMemoryBytes: RAM32 }), null);
  assert.equal(shelfFit('qwen3:8b', { totalMemoryBytes: 0 }), null, 'a machine whose memory could not be read gets no verdict');
});

// "Comfortable from ~X GB" has to be a machine someone can buy, and it has to
// agree with the prose already written on the shelf cards — those sentences
// were written by hand against the same rule, and this is what keeps them from
// drifting apart.
test('the comfortable-from threshold matches the prose the shelf cards already carry', () => {
  const at = (id) => shelfFit(id, { totalMemoryBytes: 32 * GB }).comfortableFromGB;
  assert.equal(at('qwen3.8:27b'), 48, "the reasoning entry says 'tight there, comfortable from 48'");
  assert.equal(at(QWEN), 48, "35B-A3B says 'comfortable from 48 GB of RAM, borderline at 32'");
  assert.equal(at(NEMOTRON), 48, "Nemotron says '32 GB of RAM is tight and 48 comfortable'");
  assert.equal(at('qwen3:8b'), 16, 'a small model does not demand a workstation');
  for (const id of [QWEN, NEMOTRON, 'qwen3.8:27b', 'qwen3:8b', GPT_OSS_120B]) {
    const roomy = shelfFit(id, { totalMemoryBytes: shelfFit(id, { totalMemoryBytes: 32 * GB }).comfortableFromGB * GB });
    assert.equal(roomy.fit, 'fits', `${id} must actually fit at the size we send people shopping for`);
  }
});

// One vocabulary for one verdict: the doctor imports these labels, and the
// command center's shelf badge hard-codes them. If either side is reworded
// alone, a user gets two different answers to the same question.
test('the fit vocabulary is shared between the doctor and the shelf badge', () => {
  const app = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'app.js'), 'utf8');
  const cli = fs.readFileSync(path.join(import.meta.dirname, '..', 'bin', 'sovereign.js'), 'utf8');
  for (const phrase of Object.values(FIT_LABELS)) {
    assert.ok(app.includes(`'${phrase}'`), `the shelf badge must still say "${phrase}"`);
  }
  assert.match(cli, /shelfFit/, 'the doctor takes its sizing from the shelf, never its own copy of the rule');
  assert.doesNotMatch(cli, /0\.6\s*\*|GB_PER_BILLION/, 'the sizing rule must not be re-implemented in the CLI');
});
