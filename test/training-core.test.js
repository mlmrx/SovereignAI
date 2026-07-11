import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import test from 'node:test';

import {
  TrainingValidationError,
  buildConversationExamples,
  buildDatasetSnapshot,
  normalizeHyperparameters,
  normalizeTrainingExample,
  validateDatasetSnapshot,
} from '../src/training/dataset.js';
import {
  TRAINER_PROTOCOL,
  TRAINING_JOB_SCHEMA,
  TrainerProtocolError,
  capabilities,
  cancel,
  refresh,
  submit,
} from '../src/training/client.js';

test('conversation preparation creates canonical, deduplicated, risk-flagged examples', () => {
  const conversations = [
    { id: 'conv-b', persona_id: 'p1', title: 'Duplicate', created_at: '2026-01-02T00:00:00Z' },
    { id: 'conv-a', persona_id: 'p1', title: 'Original', created_at: '2026-01-01T00:00:00Z' },
  ];
  const exchange = (conversationId, prefix) => [
    { id: `${prefix}-u`, conversation_id: conversationId, role: 'user', content: 'Email me at me@example.com' },
    { id: `${prefix}-a`, conversation_id: conversationId, role: 'assistant', content: 'I will keep sk-abcdefghijklmnop private.' },
  ];
  const examples = buildConversationExamples({
    conversations,
    messagesByConversation: {
      'conv-a': exchange('conv-a', 'a'),
      'conv-b': exchange('conv-b', 'b'),
    },
    personas: [{ id: 'p1', system_prompt: 'Be concise.' }],
  });

  assert.equal(examples.length, 1, 'identical message content is deduplicated');
  assert.deepEqual(examples[0].messages.map((message) => message.role), ['system', 'user', 'assistant']);
  assert.equal(examples[0].provenance.conversationId, 'conv-a');
  assert.deepEqual(examples[0].provenance.messageIds, ['a-u', 'a-a']);
  assert.match(examples[0].contentHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(examples[0].riskFlags, ['pii_email', 'secret_api_key']);
  assert.equal(examples[0].state, 'draft');
});

test('training example normalization enforces a canonical chat transcript', () => {
  const existing = normalizeTrainingExample({
    id: 'manual-1',
    messages: [
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'Answer' },
    ],
    provenance: { sourceType: 'manual' },
  });
  const approved = normalizeTrainingExample({ state: 'approved' }, { existing });
  assert.equal(approved.id, 'manual-1');
  assert.equal(approved.state, 'approved');
  assert.equal(approved.contentHash, existing.contentHash);

  assert.throws(
    () => normalizeTrainingExample({
      messages: [
        { role: 'assistant', content: 'Wrong order' },
        { role: 'user', content: 'Question' },
      ],
    }),
    TrainingValidationError
  );
});

test('dataset snapshots are deterministic and never split one conversation across train and eval', () => {
  const examples = ['conversation-a', 'conversation-a', 'conversation-b', 'conversation-c'].map((conversationId, index) =>
    normalizeTrainingExample({
      id: `example-${index}`,
      state: 'approved',
      messages: [
        { role: 'user', content: `Question ${index}` },
        { role: 'assistant', content: `Answer ${index}` },
      ],
      provenance: { sourceType: 'conversation', conversationId, messageIds: [`u-${index}`, `a-${index}`] },
    })
  );
  const input = {
    project: { id: 'project-1', title: 'My model', method: 'sft-lora', baseModel: 'local/base@sha256:abc' },
    examples,
    consent: { accepted: true, rightsConfirmed: true, trainerEndpoint: 'http://127.0.0.1:7331' },
    createdAt: '2026-07-10T12:00:00.000Z',
  };
  const first = buildDatasetSnapshot(input);
  const second = buildDatasetSnapshot(input);

  assert.equal(first.hash, second.hash);
  assert.equal(first.trainJsonl, second.trainJsonl);
  assert.equal(first.evalJsonl, second.evalJsonl);
  assert.equal(first.counts.total, 4);
  assert.equal(first.counts.train + first.counts.eval, 4);
  assert.ok(first.counts.eval > 0);
  assert.equal(first.manifest.split.leakageProtected, true);

  const trainConversations = new Set(parseJsonl(first.trainJsonl).map((row) => row.provenance.conversationId));
  const evalConversations = new Set(parseJsonl(first.evalJsonl).map((row) => row.provenance.conversationId));
  for (const id of trainConversations) assert.equal(evalConversations.has(id), false, `${id} leaked between splits`);
  assert.equal(first.manifest.files.train.sha256, sha256(first.trainJsonl));
  assert.equal(first.manifest.files.eval.sha256, sha256(first.evalJsonl));
  assert.equal(validateDatasetSnapshot(first).hash, first.hash);
  assert.throws(
    () => validateDatasetSnapshot({ ...first, trainJsonl: first.trainJsonl.replace('Answer', 'Tampered') }),
    /invalid contentHash|does not match JSONL bytes/
  );

  assert.throws(
    () => buildDatasetSnapshot({ ...input, consent: { accepted: false } }),
    /consent\.accepted must be true/
  );
});

test('hyperparameters are defaulted, aliases are normalized, and unsafe fields are rejected', () => {
  const value = normalizeHyperparameters({ learning_rate: 0.0001, lora_rank: 8, epochs: 2 });
  assert.equal(value.learningRate, 0.0001);
  assert.equal(value.loraRank, 8);
  assert.equal(value.epochs, 2);
  assert.equal(value.batchSize, 2);
  assert.throws(() => normalizeHyperparameters({ command: 'rm' }), /Unsupported hyperparameter/);
  assert.throws(() => normalizeHyperparameters({ loraDropout: 2 }), /between 0 and 1/);
});

test('trainer client uploads content-addressed blobs and validates the full job lifecycle', async (t) => {
  const blobs = new Map();
  const requests = [];
  let submittedBody;
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (req.headers.authorization !== 'Bearer trainer-secret') return json(res, 401, { error: 'unauthorized' });

    if (req.method === 'GET' && req.url === '/v1/capabilities') {
      return json(res, 200, {
        protocol: TRAINER_PROTOCOL,
        actualWeightTraining: true,
        methods: ['sft-lora'],
        runner: { name: 'test-trainer', version: '1.0.0' },
      });
    }
    if (req.url.startsWith('/v1/blobs/sha256:')) {
      const digest = req.url.slice('/v1/blobs/'.length);
      if (req.method === 'HEAD') {
        res.writeHead(blobs.has(digest) ? 200 : 404);
        return res.end();
      }
      if (req.method === 'PUT') {
        assert.equal(req.headers['x-content-sha256'], digest);
        assert.equal(`sha256:${sha256(body)}`, digest);
        blobs.set(digest, body);
        res.writeHead(201);
        return res.end();
      }
    }
    if (req.method === 'POST' && req.url === '/v1/training/jobs') {
      submittedBody = JSON.parse(body.toString('utf8'));
      assert.equal(req.headers['idempotency-key'], 'local-run-1');
      return json(res, 202, { id: 'remote-job-1', status: 'queued' });
    }
    if (req.method === 'GET' && req.url === '/v1/training/jobs/remote-job-1') {
      return json(res, 200, {
        id: 'remote-job-1',
        status: 'succeeded',
        progress: { completed: 100, total: 100 },
        metrics: { evalLoss: 0.42 },
        artifacts: [{
          kind: 'merged-gguf',
          sha256: 'a'.repeat(64),
          baseModel: { id: 'local/base@sha256:abc' },
          ollamaModel: 'my-trained-model:latest',
          ollamaDigest: 'b'.repeat(64),
          bytes: 1234,
        }],
      });
    }
    if (req.method === 'POST' && req.url === '/v1/training/jobs/remote-job-1/cancel') {
      return json(res, 202, { id: 'remote-job-1', status: 'cancel_requested' });
    }
    return json(res, 404, { error: 'not found' });
  });
  await listen(server);
  t.after(() => close(server));
  const address = server.address();
  const config = { baseUrl: `http://127.0.0.1:${address.port}`, authToken: 'trainer-secret' };

  const advertised = await capabilities(config);
  assert.deepEqual(advertised.methods, ['sft-lora']);

  const source = ['conversation-a', 'conversation-b'].map((conversationId, index) => normalizeTrainingExample({
    id: `approved-${index}`,
    state: 'approved',
    messages: [
      { role: 'user', content: `Prompt ${index}` },
      { role: 'assistant', content: `Completion ${index}` },
    ],
    provenance: { sourceType: 'conversation', conversationId },
  }));
  const snapshot = buildDatasetSnapshot({
    project: { id: 'project-1', method: 'sft-lora', baseModel: 'local/base@sha256:abc' },
    examples: source,
    consent: { accepted: true, trainerEndpoint: config.baseUrl },
    createdAt: '2026-07-10T12:00:00.000Z',
  });
  const queued = await submit(config, {
    runId: 'local-run-1',
    project: { id: 'project-1', title: 'Private adapter', method: 'sft-lora', baseModel: 'local/base@sha256:abc' },
    snapshot,
    hyperparameters: { epochs: 1 },
  });
  assert.deepEqual(queued, { id: 'remote-job-1', status: 'queued' });
  assert.equal(submittedBody.schema, TRAINING_JOB_SCHEMA);
  assert.equal(submittedBody.runId, 'local-run-1');
  assert.equal(submittedBody.dataset.hash, snapshot.hash);
  assert.deepEqual(submittedBody.dataset.manifest, snapshot.manifest, 'manifest is inline');
  assert.match(submittedBody.dataset.train.digest, /^sha256:[a-f0-9]{64}$/);
  assert.match(submittedBody.dataset.eval.digest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(submittedBody.output, {
    preserveAdapter: true,
    mergedModel: true,
    format: 'gguf',
    quantization: 'q4_K_M',
  });
  assert.equal(blobs.size, 2);
  assert.equal(requests.filter((request) => request.method === 'HEAD').length, 2);
  assert.equal(requests.filter((request) => request.method === 'PUT').length, 2);

  const done = await refresh(config, 'remote-job-1');
  assert.equal(done.status, 'succeeded');
  assert.equal(done.artifacts[0].ollamaModel, 'my-trained-model:latest');
  const cancellation = await cancel(config, 'remote-job-1');
  assert.equal(cancellation.status, 'cancel_requested');
});

test('trainer client rejects capability and terminal-success protocol lies', async () => {
  await assert.rejects(
    () => capabilities({ baseUrl: 'http://trainer.local' }, {
      fetchImpl: async () => new Response(JSON.stringify({
        protocol: TRAINER_PROTOCOL,
        actualWeightTraining: false,
        methods: ['sft-lora'],
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    }),
    TrainerProtocolError
  );

  await assert.rejects(
    () => refresh({ baseUrl: 'http://trainer.local' }, 'job-1', {
      fetchImpl: async () => new Response(JSON.stringify({ id: 'job-1', status: 'succeeded' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    }),
    /must return at least one verified artifact/
  );
});

function parseJsonl(value) {
  return value.trim() ? value.trim().split('\n').map((line) => JSON.parse(line)) : [];
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}
