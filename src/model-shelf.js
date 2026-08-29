/**
 * The starter shelf: a curated, dated, opinionated list of small open-weight
 * models, organized by the JOB they're good at — not a leaderboard, not
 * benchmarks, and not auto-scraped. Curation is versioned opinion: every
 * entry says why it's here, what license its weights carry, and what memory
 * it roughly needs; `curatedAt` says when that opinion was formed, because
 * this landscape churns monthly and a stale shelf should look stale.
 *
 * Small models are this product's sweet spot twice over: they are the models
 * that actually fit the hardware our users own, and they are the right shape
 * for the product's own cognition roles — the model that writes memory
 * (extraction/distillation) and the one that embeds should be small, fast,
 * and local even when chat rents a frontier model.
 *
 * Pure data + pure functions; the server route supplies live RAM numbers.
 */

import { GB_PER_BILLION_AT_Q4, USABLE_MEMORY_FRACTION } from './model-recommendation.js';

export const SHELF_CURATED_AT = '2026-08';

// Same sizing rule of thumb as model-recommendation.js (imported, so the two
// cannot drift): ~0.6 GB per billion params at Q4, against ~60% of system
// RAM usable. Net effect: a model roughly fits when its parameter count (in
// B) ≤ total RAM (in GB). The same fraction is applied to GPU memory for the
// active set of a sparse model — the KV cache and activations need room too.
const Q4_GB_PER_B = GB_PER_BILLION_AT_Q4;
const USABLE_FRACTION = USABLE_MEMORY_FRACTION;

export const MODEL_SHELF = [
  {
    role: 'everyday-chat',
    label: 'Everyday chat',
    job: 'The default local brain: general questions, drafting, summarizing.',
    models: [
      { base: 'gemma3:4b', hf: 'google/gemma-3-4b-it', paramsB: 4, license: 'Gemma Terms of Use (Google — use restrictions apply)', why: 'Best small all-rounder of its generation; strong multilingual.' },
      { base: 'qwen3:8b', hf: 'Qwen/Qwen3-8B', paramsB: 8, license: 'Apache-2.0', why: 'Stronger reasoning headroom when you have the RAM; permissive license.' },
      { base: 'llama3.2:3b', hf: 'meta-llama/Llama-3.2-3B-Instruct', paramsB: 3, license: 'Llama Community License (Meta)', why: 'Reliable, widely fine-tuned baseline with a huge ecosystem.' },
    ],
  },
  {
    role: 'memory-cognition',
    label: 'Memory & cognition',
    job: "The model that WRITES your memory: auto-extraction and distillation. Small, fast, and local — pair it with 'cognition stays home'.",
    models: [
      { base: 'qwen3:4b', hf: 'Qwen/Qwen3-4B', paramsB: 4, license: 'Apache-2.0', why: 'Follows the extraction format reliably; cheap enough to run per exchange.' },
      { base: 'llama3.2:1b', hf: 'meta-llama/Llama-3.2-1B-Instruct', paramsB: 1, license: 'Llama Community License (Meta)', why: 'Runs on anything; good enough for fact extraction on modest machines.' },
      { base: 'hf.co/LiquidAI/LFM2.5-2.6B-GGUF', hf: 'LiquidAI/LFM2.5-2.6B-GGUF', paramsB: 2.6, license: 'LFM Open License v1.0 (custom — commercial use only under US$10M annual revenue; read it)', why: 'Liquid AI’s hybrid on-device architecture with a 131K context; its card cites ~113 tokens/s on a Ryzen CPU in about 2.5 GB.' },
    ],
  },
  {
    role: 'reasoning',
    label: 'Reasoning & analysis',
    job: 'Multi-step thinking on your own hardware: plans, math, tricky questions.',
    models: [
      { base: 'qwen3.8:27b', hf: 'Qwen/Qwen3.8-27B', paramsB: 27, license: 'Apache-2.0', why: 'The strongest open dense model a 32 GB machine can run at Q4 (tight there, comfortable from 48): thinking mode, image and video input, 262K native context. The model Perplexity’s Portable Computer runs locally at launch.' },
      { base: 'deepseek-r1:7b', hf: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B', paramsB: 7, license: 'MIT', why: 'Frontier reasoning distilled into a laptop-sized model.' },
      { base: 'phi4-mini', hf: 'microsoft/Phi-4-mini-instruct', paramsB: 3.8, license: 'MIT', why: 'Punches far above its size on structured reasoning; MIT weights.' },
    ],
  },
  {
    role: 'coding',
    label: 'Coding',
    job: 'Code completion and questions inside the editor integrations.',
    models: [
      { base: 'qwen2.5-coder:7b', hf: 'Qwen/Qwen2.5-Coder-7B-Instruct', paramsB: 7, license: 'Apache-2.0', why: 'The strongest small code model of its generation.' },
      { base: 'qwen2.5-coder:1.5b', hf: 'Qwen/Qwen2.5-Coder-1.5B-Instruct', paramsB: 1.5, license: 'Apache-2.0', why: 'Fast-enough completions on machines without a GPU.' },
    ],
  },
  {
    role: 'embeddings',
    label: 'Embeddings (semantic search)',
    job: "Powers knowledge retrieval. Set it under Settings → Knowledge embeddings; BM25 keyword search always works without it.",
    models: [
      { base: 'nomic-embed-text', hf: 'nomic-ai/nomic-embed-text-v1.5', paramsB: 0.14, license: 'Apache-2.0', why: 'The default: small, solid, permissive.' },
      { base: 'bge-m3', hf: 'BAAI/bge-m3', paramsB: 0.57, license: 'MIT', why: 'Stronger multilingual retrieval when your documents aren’t only English.' },
    ],
  },
  {
    role: 'vision',
    label: 'Vision (experimental)',
    job: 'Describe or read images locally.',
    models: [
      { base: 'moondream', hf: 'vikhyatk/moondream2', paramsB: 1.9, license: 'Apache-2.0', why: 'Tiny image understanding that runs anywhere.' },
      { base: 'gemma3:12b', hf: 'google/gemma-3-12b-it', paramsB: 12, license: 'Gemma Terms of Use (Google — use restrictions apply)', why: 'Multimodal chat with real quality, if you have the RAM.' },
    ],
  },
  // Sparse mixture-of-experts models, served by FreeToken rather than Ollama
  // unless an entry says otherwise. `paramsB` stays the TOTAL parameter count
  // — that is what has to live in host RAM — and `activeParamsB` is the
  // per-token active set that actually hits the GPU — both as stated on each
  // model card (Aug 2026). For a FreeToken entry `base` is the Hugging Face
  // id, which is what `ft serve --model` takes. An entry carrying
  // `engine: 'ollama'` ships as GGUF and Ollama pulls it directly: its `base`
  // is the Ollama tag, it is sized by the Ollama locality gate, and it gets no
  // `gpuFit` — Ollama keeps the whole weight set resident, so the total-params
  // RAM rule is the only honest number. Keep this group LAST: the shelf's dense
  // ordering (and its tests) assume the first big entry is a dense one.
  {
    role: 'frontier-moe',
    label: 'Frontier-class, locally (sparse MoE)',
    engine: 'freetoken',
    job: 'Big sparse models on one gaming GPU plus host RAM: the experts live in RAM and only the few active per token hit the GPU. Served by FreeToken (one entry ships as GGUF and Ollama pulls it directly) — pick one as your default model rather than as a recipe base.',
    models: [
      { base: 'Qwen/Qwen3.6-35B-A3B', hf: 'Qwen/Qwen3.6-35B-A3B', paramsB: 35, activeParamsB: 3, architecture: 'moe', license: 'Apache-2.0', why: 'The model FreeToken was built around: 35B of knowledge, about 3B active per token — comfortable from 48 GB of RAM, borderline at 32.' },
      { base: 'openai/gpt-oss-20b', hf: 'openai/gpt-oss-20b', paramsB: 21, activeParamsB: 3.6, architecture: 'moe', license: 'Apache-2.0', why: 'OpenAI’s open-weight reasoning model in its native MXFP4 — about 13 GB on disk, with real chain-of-thought.' },
      { base: 'google/gemma-4-26B-A4B-it', hf: 'google/gemma-4-26B-A4B-it', paramsB: 25.2, activeParamsB: 3.8, architecture: 'moe', license: 'Apache-2.0', why: 'Google’s sparse Gemma 4: strong multilingual chat; multimodal upstream, served text-only here.' },
      { base: 'nemotron-3.5-lightning:30b', hf: 'nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16', paramsB: 30, activeParamsB: 3, architecture: 'moe', engine: 'ollama', license: 'OpenMDW-1.1 (commercial use allowed)', why: 'NVIDIA’s sparse hybrid (Mamba-2, attention, and MoE layers): 30B of experts, 3B active per token, a 1M context — the first frontier-tier sparse model Ollama pulls directly. About 18 GB at Q4 by our rule, so 32 GB of RAM is tight and 48 comfortable.' },
      { base: 'openai/gpt-oss-120b', hf: 'openai/gpt-oss-120b', paramsB: 117, activeParamsB: 5.1, architecture: 'moe', license: 'Apache-2.0', why: 'Near-frontier reasoning on a single desktop GPU — its experts are ~70 GB at Q4, and every one of them must live in host RAM.' },
    ],
  },
];

/** The engine that serves an entry: its own override, else its group's, else Ollama. */
export function effectiveEngine(model, group) {
  return model.engine ?? group.engine ?? 'ollama';
}

/**
 * The sparse candidates the FreeToken recommendation sizes against:
 * { base, paramsB, activeParamsB }. Only the tier's FreeToken-served entries
 * qualify — an Ollama-served sparse entry is not on FreeToken's model list,
 * so `ft serve` is not a claim we make for it.
 */
export function sparseCandidates() {
  const group = MODEL_SHELF.find((entry) => entry.role === 'frontier-moe');
  return group
    ? group.models.filter((model) => effectiveEngine(model, group) === 'freetoken').map(({ base, paramsB, activeParamsB }) => ({ base, paramsB, activeParamsB }))
    : [];
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

/**
 * The words the shelf badge uses for a fit. Exported so anything else that
 * reports a fit — `sovereign doctor` today — says exactly what the badge in
 * the command center says; a test pins the two together.
 */
export const FIT_LABELS = { fits: 'fits here', tight: 'tight fit', 'too-big': 'needs more RAM' };

// The memory sizes machines are actually sold in. A threshold is rounded UP
// to one of these, because "comfortable from 36 GB" is advice nobody can act
// on: the next machine you can buy has 48. This is also what makes the
// computed threshold agree with the prose on the shelf cards, which was
// written by hand against the same rule — 35B-A3B and Nemotron 30B both land
// on 48 GB, exactly as their `why` lines already say.
const COMMON_MEMORY_GB = [8, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512];

/**
 * How much total RAM makes `needGB` a comfortable fit rather than a tight one,
 * inverting the same rule `fitWithin` applies: need ≤ 75% of the usable
 * budget, and the budget is `USABLE_FRACTION` of total.
 */
function comfortableFromGB(needGB) {
  const exact = needGB / (USABLE_FRACTION * 0.75);
  return COMMON_MEMORY_GB.find((size) => size >= exact) ?? Math.ceil(exact);
}

/**
 * Size a configured model id against this machine, for callers outside the
 * shelf UI. Returns null when the id is not on the shelf: an unknown model's
 * parameter count is unknown, and guessing it from the name would be the kind
 * of confident wrongness this product exists to avoid.
 *
 * Matching is by Ollama tag or Hugging Face id, tolerating the `:latest`
 * suffix Ollama adds and the `hf.co/` prefix it uses for direct GGUF pulls.
 */
export function shelfFit(modelId, { totalMemoryBytes }) {
  const wanted = normalizeModelId(modelId);
  if (!wanted) return null;
  for (const group of MODEL_SHELF) {
    for (const model of group.models) {
      if (normalizeModelId(model.base) !== wanted && normalizeModelId(model.hf) !== wanted) continue;
      const totalGB = Number.isFinite(totalMemoryBytes) && totalMemoryBytes > 0 ? totalMemoryBytes / 1024 ** 3 : null;
      if (totalGB === null) return null;
      const budgetGB = totalGB * USABLE_FRACTION;
      const needGB = round1(model.paramsB * Q4_GB_PER_B);
      const fit = fitWithin(needGB, budgetGB);
      return {
        base: model.base,
        role: group.role,
        engine: effectiveEngine(model, group),
        architecture: model.architecture ?? 'dense',
        needGB,
        budgetGB: round1(budgetGB),
        fit,
        label: FIT_LABELS[fit],
        comfortableFromGB: comfortableFromGB(needGB),
      };
    }
  }
  return null;
}

function normalizeModelId(id) {
  if (typeof id !== 'string' || !id.trim()) return null;
  return id.trim().toLowerCase().replace(/^hf\.co\//, '').replace(/:latest$/, '');
}

/**
 * Three-valued fit of `needGB` against a memory budget: comfortable, tight, or
 * not at all. Thresholds are rounded to the same one decimal as the need
 * values so binary float noise (4 × 0.6 × 0.75 is 1.7999…98) cannot flip a
 * boundary case.
 */
function fitWithin(needGB, budgetGB) {
  return needGB <= round1(budgetGB * 0.75) ? 'fits' : needGB <= round1(budgetGB) ? 'tight' : 'too-big';
}

/**
 * Annotate the shelf with what fits THIS machine. Pure; RAM (and, when known,
 * the GPU) injected.
 *
 * - `endpointLocal`: whether the Ollama endpoint is on this device — the
 *   locality gate for every dense entry.
 * - `engines`: `{ [engine]: { enabled, local } }` for non-Ollama engines
 *   (today: freetoken). An entry served by such an engine is sized against
 *   this machine only when THAT engine is local; unknown engines fall back to
 *   `endpointLocal`.
 * - `gpu`: `{ vramBytes, name, unifiedMemory, source }` from hardware.js, or
 *   null when nothing was probed.
 *
 * `fit` is always computed on TOTAL params against RAM — for a sparse model
 * that is the honest number, because FreeToken keeps every expert in host
 * memory. `gpuFit` (FreeToken-served sparse entries only) sizes the active
 * set against VRAM; a sparse entry Ollama serves gets `gpuFit: null`, since
 * Ollama does not split experts between RAM and the GPU that way.
 */
export function shelfWithFit({ totalMemoryBytes, endpointLocal, engines = {}, gpu = null }) {
  const totalGB = Number.isFinite(totalMemoryBytes) && totalMemoryBytes > 0 ? totalMemoryBytes / 1024 ** 3 : null;
  const budgetGB = totalGB === null ? null : totalGB * USABLE_FRACTION;
  const vramGB = gpu && Number.isFinite(gpu.vramBytes) && gpu.vramBytes > 0 ? gpu.vramBytes / 1024 ** 3 : null;
  const vramBudgetGB = vramGB !== null && !gpu.unifiedMemory ? vramGB * USABLE_FRACTION : null;
  return {
    curatedAt: SHELF_CURATED_AT,
    note:
      'A dated, opinionated starter shelf — not a leaderboard. The landscape churns monthly: verify current versions and licenses on Hugging Face before relying on an entry. Weight licenses belong to their publishers.',
    // Sized against this machine when a local engine is on it: Ollama for the
    // dense entries, FreeToken for the sparse tier.
    sizedAgainst: endpointLocal || Object.values(engines).some((engine) => engine?.local) ? 'this machine' : null,
    gpu: gpu
      ? { vramGB: vramGB === null ? null : round1(vramGB), name: gpu.name ?? null, vendor: gpu.vendor ?? null, unifiedMemory: Boolean(gpu.unifiedMemory), source: gpu.source ?? null }
      : null,
    roles: MODEL_SHELF.map((group) => ({
      ...group,
      models: group.models.map((model) => {
        const architecture = model.architecture ?? 'dense';
        const engine = effectiveEngine(model, group);
        const engineInfo = engines[engine];
        const local = engine === 'ollama' ? Boolean(endpointLocal) : (engineInfo?.local ?? Boolean(endpointLocal));
        const needGB = round1(model.paramsB * Q4_GB_PER_B);
        const fit = budgetGB !== null && local ? fitWithin(needGB, budgetGB) : null;
        const sized = { ...model, architecture, engine, approxGBAtQ4: needGB, fit, engineEnabled: engineInfo ? Boolean(engineInfo.enabled) : null };
        if (architecture === 'moe') {
          const activeGB = round1(model.activeParamsB * Q4_GB_PER_B);
          sized.activeParamsB = model.activeParamsB;
          sized.approxActiveGBAtQ4 = activeGB;
          // Same locality gate as `fit`: a remote engine's active set is not this GPU's problem.
          // Only FreeToken streams the active set to the GPU; under Ollama the rule is RAM alone.
          // FreeToken is CUDA-only, so an active-set fit is a claim only an
          // NVIDIA card can carry. An AMD or Intel GPU gets its badge and its
          // RAM verdict, and silence about a promise we cannot keep.
          sized.gpuFit = engine === 'freetoken' && vramBudgetGB !== null && local && gpu?.vendor === 'nvidia' ? fitWithin(activeGB, vramBudgetGB) : null;
        }
        return sized;
      }),
    })),
  };
}
