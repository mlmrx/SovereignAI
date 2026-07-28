import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateModelFit, assessFineTuneReadiness, buildModelRecommendation } from '../src/model-recommendation.js';

const GB = 1024 ** 3;

test('estimateModelFit defers to the remote host when the Ollama endpoint is not local', () => {
  const fit = estimateModelFit({ totalMemoryBytes: 64 * GB, endpointLocal: false });
  assert.equal(fit.applies, false);
  assert.match(fit.reasoning, /not on this device/);
});

test('estimateModelFit reports unreadable memory without guessing a size', () => {
  assert.equal(estimateModelFit({ totalMemoryBytes: 0, endpointLocal: true }).applies, false);
  assert.equal(estimateModelFit({ totalMemoryBytes: NaN, endpointLocal: true }).applies, false);
  assert.equal(estimateModelFit({ totalMemoryBytes: -1, endpointLocal: true }).applies, false);
});

test('estimateModelFit snaps to common open-weight parameter tiers, not arbitrary numbers', () => {
  assert.equal(estimateModelFit({ totalMemoryBytes: 16 * GB, endpointLocal: true }).approxParamsB, 14);
  assert.equal(estimateModelFit({ totalMemoryBytes: 8 * GB, endpointLocal: true }).approxParamsB, 8);
  assert.equal(estimateModelFit({ totalMemoryBytes: 4 * GB, endpointLocal: true }).approxParamsB, 3);
  // Even a very constrained device gets a floor recommendation rather than nothing.
  assert.equal(estimateModelFit({ totalMemoryBytes: 0.5 * GB, endpointLocal: true }).approxParamsB, 1);
  // A very large box doesn't recommend a tier bigger than what the budget covers.
  const huge = estimateModelFit({ totalMemoryBytes: 128 * GB, endpointLocal: true });
  assert.equal(huge.approxParamsB, 70);
  assert.ok(huge.budgetGB < 128);
});

test('estimateModelFit reports the quant and a human reasoning string', () => {
  const fit = estimateModelFit({ totalMemoryBytes: 16 * GB, endpointLocal: true });
  assert.equal(fit.quant, 'Q4_K_M');
  assert.equal(fit.label, '~14B at Q4_K_M');
  assert.equal(fit.totalMemoryGB, 16);
  assert.match(fit.reasoning, /16 GB/);
  assert.match(fit.reasoning, /14B/);
});

test('assessFineTuneReadiness recommends retrieval over fine-tuning with no approved dataset', () => {
  const readiness = assessFineTuneReadiness({ maxTrainCount: 0 });
  assert.equal(readiness.suggested, false);
  assert.equal(readiness.exampleCount, 0);
  assert.match(readiness.reasoning, /No approved training dataset/);

  const nullish = assessFineTuneReadiness({ maxTrainCount: null });
  assert.equal(nullish.suggested, false);
  assert.equal(nullish.exampleCount, 0);
});

test('assessFineTuneReadiness softens (does not block) a small approved dataset', () => {
  const small = assessFineTuneReadiness({ maxTrainCount: 10 });
  assert.equal(small.suggested, false);
  assert.equal(small.exampleCount, 10);
  assert.match(small.reasoning, /10 examples/);

  const singular = assessFineTuneReadiness({ maxTrainCount: 1 });
  assert.match(singular.reasoning, /1 example\b/);
});

test('assessFineTuneReadiness suggests training once the approved dataset clears the practical floor', () => {
  const ready = assessFineTuneReadiness({ maxTrainCount: 50 });
  assert.equal(ready.suggested, true);
  assert.equal(ready.exampleCount, 50);

  const wellPast = assessFineTuneReadiness({ maxTrainCount: 400 });
  assert.equal(wellPast.suggested, true);
  assert.match(wellPast.reasoning, /400 reviewed examples/);
});

test('buildModelRecommendation composes hardware, corpus, model fit, and fine-tuning signals', () => {
  const result = buildModelRecommendation({
    totalMemoryBytes: 16 * GB,
    endpointLocal: true,
    corpus: { documents: 3, totalDocumentChars: 12000, memories: 5 },
    maxTrainCount: 120,
  });
  assert.deepEqual(result.hardware, { totalMemoryGB: 16 });
  assert.deepEqual(result.corpus, { documents: 3, totalDocumentChars: 12000, memories: 5 });
  assert.equal(result.modelFit.approxParamsB, 14);
  assert.equal(result.fineTuning.suggested, true);
  assert.equal(result.fineTuning.exampleCount, 120);
});

test('buildModelRecommendation reports a null hardware reading rather than throwing', () => {
  const result = buildModelRecommendation({
    totalMemoryBytes: NaN,
    endpointLocal: true,
    corpus: { documents: 0, totalDocumentChars: 0, memories: 0 },
    maxTrainCount: 0,
  });
  assert.equal(result.hardware.totalMemoryGB, null);
  assert.equal(result.modelFit.applies, false);
});
