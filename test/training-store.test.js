import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ImportValidationError, openDb } from '../src/db.js';

function tempStore(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root, store: openDb(path.join(root, 'data')) };
}

test('training projects preserve reviewed examples, immutable datasets, runs, and portable history', () => {
  const first = tempStore('sovereign-training-store-a-');
  const second = tempStore('sovereign-training-store-b-');
  try {
    const persona = first.store.createPersona({ name: 'Trainer target', system_prompt: 'Be concise.' });
    const project = first.store.createTrainingProject({
      title: 'Concise analyst',
      goal: 'Return evidence, risks, and actions.',
      base_model: 'llama3.2:3b',
      target_persona_id: persona.id,
      method: 'sft-qlora',
    });
    const examples = first.store.replaceTrainingExamples(project.id, [{
      id: 'example-1',
      system: 'Be concise.',
      user: 'What happened?',
      assistant: 'Evidence: one event. Risk: low. Action: verify.',
      provenance: { sourceType: 'conversation', conversationId: 'conversation-1', messageIds: ['u1', 'a1'] },
      risk_flags: ['possible_email'],
      content_hash: 'a'.repeat(64),
      included: true,
    }], {
      sourceConversations: ['conversation-1'],
      consent: { rightsConfirmed: true, sensitiveDataReviewed: true },
    });
    assert.equal(examples.length, 1);
    assert.deepEqual(examples[0].risk_flags, ['possible_email']);

    const reviewed = first.store.updateTrainingExample('example-1', {
      assistant: 'Evidence: verified. Risk: low. Action: monitor.',
      risk_flags: [],
      content_hash: 'b'.repeat(64),
    });
    assert.equal(reviewed.included, true);
    assert.equal(first.store.getTrainingProject(project.id).status, 'review');

    const dataset = first.store.createTrainingDataset({
      project_id: project.id,
      format: 'sovereignai.training-dataset/v1',
      hash: 'c'.repeat(64),
      manifest: { schema: 'sovereignai.training-dataset/v1', counts: { train: 1, eval: 0 } },
      train_jsonl: '{"messages":[]}\n',
      eval_jsonl: '',
      train_count: 1,
      eval_count: 0,
      consent: { accepted: true },
    });
    const run = first.store.createTrainingRun({
      project_id: project.id,
      dataset_id: dataset.id,
      endpoint: 'http://127.0.0.1:7331',
      status: 'queued',
      hyperparameters: { epochs: 3 },
      submission_consent: { accepted: true, datasetHash: dataset.hash, trainerEndpoint: 'http://127.0.0.1:7331' },
    });
    const completed = first.store.updateTrainingRun(run.id, {
      status: 'succeeded',
      progress: 1,
      metrics: { eval_loss: 0.42 },
      artifact: {
        kind: 'merged-gguf', sha256: 'd'.repeat(64), bytes: 1234,
        ollamaModel: 'concise-analyst:latest', ollamaDigest: 'e'.repeat(64),
        baseModel: { id: 'llama3.2:3b' },
      },
      completed_at: new Date().toISOString(),
      evaluation_decision: 'approved',
    });
    assert.equal(completed.metrics.eval_loss, 0.42);
    assert.equal(completed.artifact.ollamaModel, 'concise-analyst:latest');

    const dump = first.store.exportAll();
    for (const key of ['training_projects', 'training_examples', 'training_datasets', 'training_runs']) {
      assert.equal(dump[key].length, 1, `${key} must be portable`);
    }
    const counts = second.store.importAll(dump);
    assert.equal(counts.training_projects, 1);
    assert.equal(second.store.listTrainingExamples(project.id)[0].assistant, reviewed.assistant);
    assert.equal(second.store.getTrainingDataset(dataset.id).manifest.counts.train, 1);
    assert.equal(second.store.getTrainingRun(run.id).artifact.sha256, 'd'.repeat(64));
    assert.equal(second.store.getTrainingRun(run.id).submission_consent.datasetHash, dataset.hash);
  } finally {
    first.store.close();
    second.store.close();
    fs.rmSync(first.root, { recursive: true, force: true });
    fs.rmSync(second.root, { recursive: true, force: true });
  }
});

test('training import rejects orphaned children before writing anything', () => {
  const { root, store } = tempStore('sovereign-training-store-invalid-');
  try {
    assert.throws(() => store.importAll({
      training_examples: [{
        id: 'orphan', project_id: 'missing', system: '', user: 'u', assistant: 'a',
        provenance: {}, included: true, risk_flags: [], content_hash: 'e'.repeat(64),
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }],
    }), ImportValidationError);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM training_examples').get().count, 0);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
