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

// Common open-weight parameter counts, smallest to largest. The
// recommendation snaps to one of these — "~6.3B" isn't a size anyone ships.
const COMMON_PARAM_TIERS_B = [1, 3, 7, 8, 13, 14, 32, 34, 70, 405];

// Fraction of total system RAM assumed available for model weights: reserves
// room for the OS, SovereignAI itself, the KV cache/context window, and
// whatever else is running. A rule-of-thumb safety margin, not a measurement.
const USABLE_MEMORY_FRACTION = 0.6;

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
        'The configured Ollama endpoint is not on this device, so this device’s memory does not constrain model size — size against that host’s resources instead.',
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

/** Combine hardware fit and fine-tuning readiness into one payload for the API. */
export function buildModelRecommendation({ totalMemoryBytes, endpointLocal, corpus, maxTrainCount }) {
  return {
    hardware: { totalMemoryGB: Number.isFinite(totalMemoryBytes) ? round1(totalMemoryBytes / 1024 ** 3) : null },
    corpus,
    modelFit: estimateModelFit({ totalMemoryBytes, endpointLocal }),
    fineTuning: assessFineTuneReadiness({ maxTrainCount }),
  };
}
