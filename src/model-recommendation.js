/**
 * Heuristic guidance for two decisions Model Studio and Fine-Tuning Studio
 * otherwise leave entirely to guesswork: "what size/quantization of model
 * will actually run on this machine" and "is there enough of a reviewed
 * training set for a LoRA run to be worthwhile, or is retrieval enough."
 *
 * Deliberately not machine learning: both are small, explainable rules over
 * numbers the app already has (this device's memory, the configured Ollama
 * endpoint's locality, the workspace's document/memory counts, and the
 * largest approved training dataset). Pure functions — no I/O — so the
 * server route only has to gather live values (os.totalmem(), the store) and
 * hand them in; see the `/api/model-recommendation` route in server.js.
 */

// Approximate resident GB per billion parameters at a GGUF quantization
// level (weights only). Real footprint also depends on architecture (dense
// vs MoE), embedding/vocab size, and context length — this is a sizing
// heuristic, not a guarantee, which is why the output says "roughly."
const QUANT_GB_PER_BILLION_PARAMS = {
  Q4_K_M: 0.6,
  Q5_K_M: 0.7,
  Q6_K: 0.8,
  Q8_0: 1.1,
  F16: 2.1,
};
const DEFAULT_QUANT = 'Q4_K_M';
// Single source of the Q4 rule of thumb: model-shelf.js imports this so the
// two sizing surfaces can never disagree by a decimal.
export const GB_PER_BILLION_AT_Q4 = QUANT_GB_PER_BILLION_PARAMS[DEFAULT_QUANT];

// Common open-weight parameter counts, smallest to largest. The
// recommendation snaps to one of these — "~6.3B" isn't a size anyone ships.
const COMMON_PARAM_TIERS_B = [1, 3, 7, 8, 13, 14, 32, 34, 70, 405];

// Fraction of total system RAM assumed available for model weights: reserves
// room for the OS, SovereignAI itself, the KV cache/context window, and
// whatever else is running. A rule-of-thumb safety margin, not a measurement.
export const USABLE_MEMORY_FRACTION = 0.6;

// Commonly-cited practical floor for a LoRA run to produce a noticeable
// style/format shift. Not a hard requirement — smaller sets can still work
// for a narrow enough task — so this only softens the recommendation, it
// never blocks Fine-Tuning Studio itself.
const MIN_EXAMPLES_FOR_USEFUL_LORA = 50;

function round1(value) {
  return Math.round(value * 10) / 10;
}

/** Largest common parameter tier (billions) that fits within `budgetGB`. */
function largestTierWithinBudget(budgetGB, gbPerBillion) {
  const maxParamsB = budgetGB / gbPerBillion;
  for (let i = COMMON_PARAM_TIERS_B.length - 1; i >= 0; i--) {
    if (COMMON_PARAM_TIERS_B[i] <= maxParamsB) return COMMON_PARAM_TIERS_B[i];
  }
  return COMMON_PARAM_TIERS_B[0];
}

/**
 * Estimate the largest common open-weight size that should run comfortably.
 * `endpointLocal` gates whether this device's memory is even the right thing
 * to size against — a remote/BYOC Ollama endpoint has its own resources.
 */
export function estimateModelFit({ totalMemoryBytes, endpointLocal }) {
  if (!endpointLocal) {
    return {
      applies: false,
      reasoning:
        'The default model endpoint is not on this device, so this device’s memory does not constrain model size — size against that host’s resources instead.',
    };
  }
  if (!Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) {
    return { applies: false, reasoning: 'This device’s memory could not be read.' };
  }

  const totalMemoryGB = totalMemoryBytes / 1024 ** 3;
  const budgetGB = totalMemoryGB * USABLE_MEMORY_FRACTION;
  const gbPerBillion = QUANT_GB_PER_BILLION_PARAMS[DEFAULT_QUANT];
  const approxParamsB = largestTierWithinBudget(budgetGB, gbPerBillion);

  return {
    applies: true,
    totalMemoryGB: round1(totalMemoryGB),
    budgetGB: round1(budgetGB),
    quant: DEFAULT_QUANT,
    approxParamsB,
    label: `~${approxParamsB}B at ${DEFAULT_QUANT}`,
    reasoning:
      `This device reports ${round1(totalMemoryGB)} GB of memory. Reserving headroom for the OS, this app, and the context window, roughly ${round1(budgetGB)} GB is usable for model weights — comfortable for a ~${approxParamsB}B model at ${DEFAULT_QUANT}. Larger context windows or running other memory-heavy apps at the same time will eat into this.`,
  };
}

/**
 * Sparse (mixture-of-experts) models change the ceiling: served by FreeToken,
 * ALL expert weights sit in host RAM and only the few experts active for a
 * given token stream to the GPU. So the dense rule still applies to the TOTAL
 * parameter count against RAM, and a second rule sizes the ACTIVE set against
 * VRAM. `candidates` are the shelf's frontier-moe entries
 * ({ base, paramsB, activeParamsB }); the largest one clearing both rules is
 * reported, or null when none does.
 *
 * VRAM unknown (no probe result) or unified memory (Apple Silicon) skips the
 * GPU rule — on unified memory the RAM rule already is the GPU rule.
 */
export function estimateSparseFit({ totalMemoryBytes, vramBytes = null, unifiedMemory = false, gpuVendor = null, engineLocal, candidates = [] }) {
  if (!engineLocal) {
    return {
      applies: false,
      largest: null,
      reasoning: 'The sparse-model engine is not on this device, so this device’s memory does not constrain sparse model size.',
    };
  }
  if (!Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) {
    return { applies: false, largest: null, reasoning: 'This device’s memory could not be read, so sparse model fit could not be estimated.' };
  }

  if (unifiedMemory) {
    // FreeToken is x86_64 + NVIDIA today; a Metal backend is on its roadmap, not shipped.
    return { applies: true, largest: null, reasoning: 'FreeToken does not run on Apple Silicon yet (a Metal backend is on its roadmap), so the sparse tier is not sized for this machine.' };
  }
  if (gpuVendor === 'amd' || gpuVendor === 'intel') {
    // The card is real and its memory is known; FreeToken simply cannot use
    // it. Better to name the reason than to size an active set against a GPU
    // no engine here will ever stream experts to.
    const label = gpuVendor === 'amd' ? 'an AMD' : 'an Intel';
    return { applies: true, largest: null, reasoning: `FreeToken needs an NVIDIA GPU (CUDA), and this machine has ${label} one, so the sparse tier is not sized for it. The dense shelf is unaffected — Ollama runs on this card.` };
  }
  const totalMemoryGB = totalMemoryBytes / 1024 ** 3;
  const budgetGB = totalMemoryGB * USABLE_MEMORY_FRACTION;
  const vramGB = Number.isFinite(vramBytes) && vramBytes > 0 ? vramBytes / 1024 ** 3 : null;
  const vramKnown = vramGB !== null && !unifiedMemory;
  const vramBudgetGB = vramKnown ? vramGB * USABLE_MEMORY_FRACTION : null;
  const gbPerBillion = GB_PER_BILLION_AT_Q4;

  const usable = candidates.filter((c) => Number.isFinite(c?.paramsB) && c.paramsB > 0 && Number.isFinite(c?.activeParamsB) && c.activeParamsB > 0);
  const fitting = usable.filter((c) => {
    // Budgets rounded to the same one decimal as the need values, so binary
    // float noise cannot flip a boundary case (4 × 0.6 is 2.3999…99).
    const needGB = round1(c.paramsB * gbPerBillion);
    if (needGB > round1(budgetGB)) return false;
    if (!vramKnown) return true;
    return round1(c.activeParamsB * gbPerBillion) <= round1(vramBudgetGB);
  });
  const largest = fitting.length ? fitting.reduce((best, c) => (c.paramsB > best.paramsB ? c : best)) : null;
  const vramClause = vramKnown ? '' : ' GPU memory could not be read, so only the RAM rule was applied.';

  if (!largest) {
    if (!usable.length) {
      return { applies: true, largest: null, reasoning: 'No sparse (MoE) candidates were supplied to size against.' };
    }
    const smallestNeedGB = round1(Math.min(...usable.map((c) => c.paramsB)) * gbPerBillion);
    const smallestActiveGB = round1(Math.min(...usable.map((c) => c.activeParamsB)) * gbPerBillion);
    const ramBlocks = smallestNeedGB > round1(budgetGB);
    // The GPU sentence is only true when no active set at all fits; otherwise the
    // block is the combination (the entries RAM admits need more VRAM, and vice versa).
    const gpuBlocks = vramKnown && smallestActiveGB > round1(vramBudgetGB);
    return {
      applies: true,
      largest: null,
      reasoning: ramBlocks
        ? `Sparse (MoE) models need their full weights in RAM — the smallest on the shelf needs about ${smallestNeedGB} GB, and this machine reserves less than that for model weights.${vramClause}`
        : gpuBlocks
          ? `Sparse (MoE) models keep their experts in RAM but still stream an active set to the GPU — this machine’s ${round1(vramGB)} GB of GPU memory is too small for even the smallest active set on the shelf.`
          : `No sparse (MoE) model on the shelf clears both rules here: the ones whose experts fit in this machine’s RAM need more than its ${round1(vramGB)} GB of GPU memory for their active set, and the ones whose active set fits need more RAM.`,
    };
  }

  const { base, paramsB, activeParamsB } = largest;
  const gpuClause = vramKnown
    ? ` while the ${round1(vramGB)} GB GPU runs the ~${activeParamsB}B active set`
    : ` and stream only its ~${activeParamsB}B active set to the GPU`;
  return {
    applies: true,
    largest: { base, paramsB, activeParamsB },
    reasoning:
      `Sparse (MoE) models change the ceiling: with FreeToken, this machine’s ${round1(totalMemoryGB)} GB of RAM can hold the experts of ${base} (${paramsB}B total)${gpuClause}.${vramClause} See the frontier tier on the starter shelf.`,
  };
}

/**
 * Whether the workspace's training investment looks worth an actual LoRA
 * run, versus retrieval (system prompt + knowledge base) already covering
 * it. `maxTrainCount` is the largest approved (locked) training dataset
 * across all Fine-Tuning Studio projects, or 0/null if none exists yet.
 */
export function assessFineTuneReadiness({ maxTrainCount }) {
  const count = Number.isFinite(maxTrainCount) ? maxTrainCount : 0;

  if (count <= 0) {
    return {
      suggested: false,
      exampleCount: 0,
      reasoning:
        'No approved training dataset yet. Retrieval (knowledge base + memory) already covers most personalization — Fine-Tuning Studio is worth it once you have a reviewed, locked set of examples that show the model *how* to respond, not just facts for it to draw on.',
    };
  }
  if (count < MIN_EXAMPLES_FOR_USEFUL_LORA) {
    return {
      suggested: false,
      exampleCount: count,
      reasoning:
        `The largest approved dataset has ${count} example${count === 1 ? '' : 's'}. That can still work for a narrow style or format change, but ${MIN_EXAMPLES_FOR_USEFUL_LORA}+ reviewed examples is a more typical floor for a noticeable effect — reviewing more conversations before training is likely worth it.`,
    };
  }
  return {
    suggested: true,
    exampleCount: count,
    reasoning:
      `An approved dataset with ${count} reviewed examples is ready. That's enough for an actual LoRA run in Fine-Tuning Studio to be worthwhile if you want the model's behavior or style shaped, not just its knowledge.`,
  };
}

/**
 * Combine hardware fit and fine-tuning readiness into one payload for the API.
 * `hardware`/`corpus`/`modelFit`/`fineTuning` keep their original shape; `gpu`
 * (the probe result as the shelf presents it, or null) and `sparseFit`
 * (estimateSparseFit, or null when no `sparse = { engineLocal, candidates }`
 * was given) are additive.
 */
export function buildModelRecommendation({ totalMemoryBytes, endpointLocal, corpus, maxTrainCount, gpu = null, sparse = null }) {
  const vramGB = gpu && Number.isFinite(gpu.vramBytes) && gpu.vramBytes > 0 ? round1(gpu.vramBytes / 1024 ** 3) : null;
  return {
    hardware: { totalMemoryGB: Number.isFinite(totalMemoryBytes) ? round1(totalMemoryBytes / 1024 ** 3) : null },
    corpus,
    modelFit: estimateModelFit({ totalMemoryBytes, endpointLocal }),
    fineTuning: assessFineTuneReadiness({ maxTrainCount }),
    gpu: gpu ? { vramGB, name: gpu.name ?? null, vendor: gpu.vendor ?? null, unifiedMemory: Boolean(gpu.unifiedMemory), source: gpu.source ?? null } : null,
    sparseFit: sparse
      ? estimateSparseFit({
          totalMemoryBytes,
          vramBytes: gpu?.vramBytes ?? null,
          unifiedMemory: Boolean(gpu?.unifiedMemory),
          gpuVendor: gpu?.vendor ?? null,
          engineLocal: sparse.engineLocal,
          candidates: sparse.candidates,
        })
      : null,
  };
}
