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

export const SHELF_CURATED_AT = '2026-08';

// Same sizing rule of thumb as model-recommendation.js: ~0.6 GB per billion
// params at Q4, against ~60% of system RAM usable. Net effect: a model
// roughly fits when its parameter count (in B) ≤ total RAM (in GB).
const Q4_GB_PER_B = 0.6;
const USABLE_FRACTION = 0.6;

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
      { base: 'hf.co/LiquidAI/LFM2-1.2B-GGUF', hf: 'LiquidAI/LFM2-1.2B-GGUF', paramsB: 1.2, license: 'LFM Open License (custom — read it)', why: 'Liquid AI’s edge-first architecture: unusually fast on CPU for its quality.' },
    ],
  },
  {
    role: 'reasoning',
    label: 'Reasoning & analysis',
    job: 'Multi-step thinking on your own hardware: plans, math, tricky questions.',
    models: [
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
];

/** Annotate the shelf with what fits THIS machine. Pure; RAM injected. */
export function shelfWithFit({ totalMemoryBytes, endpointLocal }) {
  const totalGB = Number.isFinite(totalMemoryBytes) && totalMemoryBytes > 0 ? totalMemoryBytes / 1024 ** 3 : null;
  const budgetGB = totalGB === null ? null : totalGB * USABLE_FRACTION;
  return {
    curatedAt: SHELF_CURATED_AT,
    note:
      'A dated, opinionated starter shelf — not a leaderboard. The landscape churns monthly: verify current versions and licenses on Hugging Face before relying on an entry. Weight licenses belong to their publishers.',
    sizedAgainst: endpointLocal ? 'this machine' : null,
    roles: MODEL_SHELF.map((group) => ({
      ...group,
      models: group.models.map((model) => {
        const needGB = Math.round(model.paramsB * Q4_GB_PER_B * 10) / 10;
        let fit = null;
        if (budgetGB !== null && endpointLocal) {
          fit = needGB <= budgetGB * 0.75 ? 'fits' : needGB <= budgetGB ? 'tight' : 'too-big';
        }
        return { ...model, approxGBAtQ4: needGB, fit };
      }),
    })),
  };
}
