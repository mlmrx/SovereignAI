import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { buildDatasetSnapshot, normalizeTrainingExample } from '../src/training/dataset.js';

test('guided fine-tuning API freezes reviewed data, runs a self-hosted trainer, evaluates, and assigns Ollama', async () => {
  const trainerState = { blobs: new Map(), submissions: [], refreshes: 0, ollamaDigest: 'b'.repeat(64) };
  const trainer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://trainer.local');
    if (req.method === 'GET' && url.pathname === '/v1/capabilities') {
      return json(res, 200, {
        protocol: 'sovereignai.trainer/v1',
        actualWeightTraining: true,
        methods: ['sft-qlora', 'sft-lora'],
      });
    }
    const blob = url.pathname.match(/^\/v1\/blobs\/(sha256:[a-f0-9]{64})$/);
    if (blob && req.method === 'HEAD') {
      res.writeHead(trainerState.blobs.has(blob[1]) ? 200 : 404);
      return res.end();
    }
    if (blob && req.method === 'PUT') {
      trainerState.blobs.set(blob[1], await readBody(req));
      res.writeHead(201);
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/v1/training/jobs') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      trainerState.submissions.push({ body, idempotency: req.headers['idempotency-key'] });
      return json(res, 202, {
        id: `trainer-${trainerState.submissions.length}`,
        status: 'queued',
        progress: { fraction: 0.1, stage: 'Queued on local GPU' },
      });
    }
    if (req.method === 'GET' && /^\/v1\/training\/jobs\/trainer-\d+$/.test(url.pathname)) {
      trainerState.refreshes += 1;
      return json(res, 200, {
        id: url.pathname.split('/').at(-1),
        status: 'succeeded',
        progress: { fraction: 1, stage: 'Merged and registered in Ollama' },
        metrics: { train_loss: 0.42, eval_loss: 0.51 },
        artifacts: [{
          kind: 'merged-gguf',
          sha256: 'a'.repeat(64),
          bytes: 123456,
          baseModel: { id: 'llama3.2:3b' },
          ollamaModel: 'sovereign-test-tuned:latest',
          ollamaDigest: 'b'.repeat(64),
        }],
      });
    }
    if (req.method === 'POST' && /^\/v1\/training\/jobs\/trainer-\d+\/cancel$/.test(url.pathname)) {
      return json(res, 202, { id: url.pathname.split('/').at(-2), status: 'cancel_requested' });
    }
    json(res, 404, { error: 'mock trainer route not found' });
  });
  await listen(trainer);

  const ollama = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') {
      return json(res, 200, { models: [{ name: 'sovereign-test-tuned:latest', digest: trainerState.ollamaDigest }] });
    }
    json(res, 404, { error: 'mock Ollama route not found' });
  });
  await listen(ollama);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-training-api-'));
  fs.writeFileSync(path.join(root, 'sovereign.config.json'), JSON.stringify({
    embeddings: { provider: 'ollama', model: '' },
    providers: { ollama: { enabled: true, baseUrl: origin(ollama) } },
    training: { enabled: true, baseUrl: origin(trainer) },
  }));
  const app = createApp(root, { env: {} });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = origin(app.server);

  try {
    const persona = app.store.listPersonas()[0];
    const first = addConversation(app.store, persona.id, 'Incident one', 'Summarize incident one', 'Risk: latency. Action: inspect traces.');
    const second = addConversation(app.store, persona.id, 'Incident two', 'Summarize incident two', 'Risk: saturation. Action: reduce load.');

    const sources = await api(base, 'GET', '/api/training/sources');
    assert.equal(sources.status, 200);
    assert.deepEqual(new Set(sources.body.sources.map((source) => source.id)), new Set([first.id, second.id]));
    assert.ok(sources.body.sources.every((source) => source.example_count === 1));

    const created = await api(base, 'POST', '/api/training/projects', {
      title: 'Evidence-first incidents',
      goal: 'Teach a concise risk and action format.',
      base_model: 'llama3.2:3b',
      target_persona_id: persona.id,
      method: 'sft-qlora',
    });
    assert.equal(created.status, 200);
    const projectId = created.body.project.id;

    const missingConsent = await api(base, 'POST', `/api/training/projects/${projectId}/prepare`, {
      sources: [{ type: 'conversation', id: first.id }],
      consent: { rights: true, sensitive: true },
    });
    assert.equal(missingConsent.status, 400);
    assert.match(missingConsent.body.error, /trainer destination/i);

    const prepared = await api(base, 'POST', `/api/training/projects/${projectId}/prepare`, {
      sources: [first, second].map((conversation) => ({ type: 'conversation', id: conversation.id })),
      consent: { rights: true, sensitive: true, local: true },
    });
    assert.equal(prepared.status, 200);
    assert.equal(prepared.body.examples.length, 2);
    assert.ok(prepared.body.examples.every((example) => example.reviewed === false));

    const tooEarly = await api(base, 'POST', `/api/training/projects/${projectId}/datasets`, {
      example_ids: prepared.body.examples.map((example) => example.id),
      consent: { accepted: true, riskAccepted: true },
    });
    assert.equal(tooEarly.status, 409);
    assert.match(tooEarly.body.error, /review and save every included/i);

    const reviewed = [];
    for (const example of prepared.body.examples) {
      const saved = await api(base, 'PUT', `/api/training/examples/${example.id}`, {
        included: true,
        messages: [
          ...(example.system ? [{ role: 'system', content: example.system }] : []),
          { role: 'user', content: example.user },
          { role: 'assistant', content: example.assistant },
        ],
      });
      assert.equal(saved.status, 200);
      assert.equal(saved.body.example.reviewed, true);
      reviewed.push(saved.body.example);
    }

    const originalFirst = reviewed[0];
    const secretEdit = await api(base, 'PUT', `/api/training/examples/${originalFirst.id}`, {
      included: true,
      messages: [
        ...(originalFirst.system ? [{ role: 'system', content: originalFirst.system }] : []),
        { role: 'user', content: originalFirst.user },
        { role: 'assistant', content: 'api_key=supersecretcredential' },
      ],
    });
    assert.equal(secretEdit.status, 200);
    assert.ok(secretEdit.body.example.risk_flags.includes('secret_credential'));
    const secretLock = await api(base, 'POST', `/api/training/projects/${projectId}/datasets`, {
      example_ids: reviewed.map((example) => example.id),
      consent: { accepted: true, riskAccepted: true },
    });
    assert.equal(secretLock.status, 400);
    assert.match(secretLock.body.error, /remove detected credentials/i);
    const restoredFirst = await api(base, 'PUT', `/api/training/examples/${originalFirst.id}`, {
      included: true,
      messages: [
        ...(originalFirst.system ? [{ role: 'system', content: originalFirst.system }] : []),
        { role: 'user', content: originalFirst.user },
        { role: 'assistant', content: originalFirst.assistant },
      ],
    });
    assert.equal(restoredFirst.status, 200);
    reviewed[0] = restoredFirst.body.example;

    const missingFinalApproval = await api(base, 'POST', `/api/training/projects/${projectId}/datasets`, {
      example_ids: reviewed.map((example) => example.id),
      consent: { riskAccepted: true },
    });
    assert.equal(missingFinalApproval.status, 400);
    assert.match(missingFinalApproval.body.error, /consent\.accepted/i);

    const locked = await api(base, 'POST', `/api/training/projects/${projectId}/datasets`, {
      example_ids: reviewed.map((example) => example.id),
      consent: { accepted: true, riskAccepted: true },
    });
    assert.equal(locked.status, 200);
    assert.equal(locked.body.dataset.train_count, 1);
    assert.equal(locked.body.dataset.eval_count, 1);
    assert.equal(locked.body.dataset.manifest.split.leakageProtected, true);
    assert.deepEqual(locked.body.dataset.manifest.project.baseModel, { id: 'llama3.2:3b' });
    const datasetId = locked.body.dataset.id;

    const frozenEdit = await api(base, 'PUT', `/api/training/examples/${reviewed[0].id}`, {
      included: false,
      messages: [{ role: 'user', content: 'Changed' }, { role: 'assistant', content: 'Changed' }],
    });
    assert.equal(frozenEdit.status, 409);

    const exportResult = await api(base, 'GET', `/api/training/datasets/${datasetId}/export`);
    assert.equal(exportResult.status, 200);
    assert.equal(exportResult.body.manifest.hash, locked.body.dataset.hash);
    assert.match(exportResult.body.trainJsonl, /"messages"/);
    assert.match(exportResult.body.evalJsonl, /"messages"/);

    const capability = await api(base, 'GET', '/api/training/capabilities');
    assert.equal(capability.status, 200);
    assert.equal(capability.body.available, true);
    assert.equal(capability.body.actualWeightTraining, true);

    const missingRunConsent = await api(base, 'POST', `/api/training/datasets/${datasetId}/runs`, {
      trainer: { endpoint: origin(trainer) },
      method: 'sft-qlora',
      base_model: 'llama3.2:3b',
      hyperparameters: { epochs: 2, loraRank: 8 },
    });
    assert.equal(missingRunConsent.status, 400);
    assert.match(missingRunConsent.body.error, /training-run consent/i);

    const started = await api(base, 'POST', `/api/training/datasets/${datasetId}/runs`, {
      trainer: { endpoint: origin(trainer) },
      method: 'sft-qlora',
      base_model: 'llama3.2:3b',
      hyperparameters: { epochs: 2, loraRank: 8 },
      consent: {
        accepted: true,
        datasetHash: locked.body.dataset.hash,
        trainerEndpoint: origin(trainer),
      },
    });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.run.status, 'queued');
    assert.equal(trainerState.submissions.length, 1);
    assert.equal(trainerState.submissions[0].body.schema, 'sovereignai.training-job/v1');
    assert.equal(trainerState.submissions[0].body.baseModel.id, 'llama3.2:3b');
    assert.equal(trainerState.submissions[0].body.output.mergedModel, true);
    assert.equal(trainerState.submissions[0].idempotency, started.body.run.id);
    assert.equal(trainerState.blobs.size, 2);

    const refreshed = await api(base, 'POST', `/api/training/runs/${started.body.run.id}/refresh`, {});
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.run.status, 'succeeded');
    assert.equal(refreshed.body.run.artifact.ollamaModel, 'sovereign-test-tuned:latest');
    assert.equal(refreshed.body.run.metrics.eval_loss, 0.51);

    const blockedDeploy = await api(base, 'POST', `/api/training/runs/${started.body.run.id}/deploy`, {
      model: 'sovereign-test-tuned:latest',
      persona_id: persona.id,
    });
    assert.equal(blockedDeploy.status, 409);

    const evaluation = await api(base, 'POST', `/api/training/runs/${started.body.run.id}/evaluate`, { action: 'evaluate' });
    assert.equal(evaluation.status, 200);
    assert.equal(evaluation.body.evaluation.holdout.records, 1);
    assert.equal(evaluation.body.evaluation.metrics.eval_loss, 0.51);

    const approved = await api(base, 'POST', `/api/training/runs/${started.body.run.id}/evaluate`, {
      decision: 'approved',
      notes: 'Holdout loss is acceptable; manual chat checks passed.',
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.run.evaluation_decision, 'approved');

    trainerState.ollamaDigest = 'c'.repeat(64);
    const wrongDigest = await api(base, 'POST', `/api/training/runs/${started.body.run.id}/deploy`, {
      model: 'sovereign-test-tuned:latest',
      persona_id: persona.id,
    });
    assert.equal(wrongDigest.status, 409);
    assert.match(wrongDigest.body.error, /digest does not match/i);
    trainerState.ollamaDigest = 'b'.repeat(64);

    const deployed = await api(base, 'POST', `/api/training/runs/${started.body.run.id}/deploy`, {
      model: 'sovereign-test-tuned:latest',
      persona_id: persona.id,
    });
    assert.equal(deployed.status, 200);
    assert.equal(deployed.body.deployment.status, 'deployed');
    assert.equal(deployed.body.persona.provider, 'ollama');
    assert.equal(deployed.body.persona.model, 'sovereign-test-tuned:latest');
    assert.ok(deployed.body.run.deployed_at);

    app.store.db.prepare('UPDATE training_datasets SET train_jsonl = train_jsonl || ? WHERE id = ?').run(' ', datasetId);
    const tampered = await api(base, 'POST', `/api/training/datasets/${datasetId}/runs`, {
      trainer: { endpoint: origin(trainer) },
      method: 'sft-qlora',
      base_model: 'llama3.2:3b',
      hyperparameters: { epochs: 2, loraRank: 8 },
      consent: { accepted: true, datasetHash: locked.body.dataset.hash, trainerEndpoint: origin(trainer) },
    });
    assert.equal(tampered.status, 400);
    assert.match(tampered.body.error, /integrity|JSONL bytes|blank lines|valid JSON/i);
    assert.equal(trainerState.submissions.length, 1, 'tampered data must not reach the trainer');
  } finally {
    await close(app.server);
    app.store.close();
    await close(trainer);
    await close(ollama);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an indeterminate submission blocks duplicate runs and retries the same idempotency key', async () => {
  const submissions = [];
  const blobs = new Set();
  let dropFirstSubmission = true;
  const trainer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://trainer.local');
    if (req.method === 'GET' && url.pathname === '/v1/capabilities') {
      return json(res, 200, { protocol: 'sovereignai.trainer/v1', actualWeightTraining: true, methods: ['sft-lora'] });
    }
    const blob = url.pathname.match(/^\/v1\/blobs\/(sha256:[a-f0-9]{64})$/);
    if (blob && req.method === 'HEAD') {
      res.writeHead(blobs.has(blob[1]) ? 200 : 404);
      return res.end();
    }
    if (blob && req.method === 'PUT') {
      await readBody(req);
      blobs.add(blob[1]);
      res.writeHead(201);
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/v1/training/jobs') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      submissions.push({ runId: body.runId, key: req.headers['idempotency-key'] });
      if (dropFirstSubmission) {
        dropFirstSubmission = false;
        req.socket.destroy();
        return;
      }
      return json(res, 202, { id: 'recovered-job', status: 'queued' });
    }
    json(res, 404, { error: 'not found' });
  });
  await listen(trainer);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-training-retry-'));
  fs.writeFileSync(path.join(root, 'sovereign.config.json'), JSON.stringify({
    embeddings: { provider: 'ollama', model: '' },
    providers: { ollama: { enabled: false } },
    training: { enabled: true, baseUrl: origin(trainer) },
  }));
  const app = createApp(root, { env: {} });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = origin(app.server);

  try {
    const project = app.store.createTrainingProject({
      title: 'Retry safety', goal: 'Do not duplicate GPU jobs.', base_model: 'local/base', method: 'sft-lora',
      consent: { rights: true, sensitive: true, local: true, trainerEndpoint: origin(trainer) },
    });
    const examples = ['retry-a', 'retry-b'].map((conversationId, index) => normalizeTrainingExample({
      id: `retry-${index}`,
      state: 'approved',
      messages: [{ role: 'user', content: `Question ${index}` }, { role: 'assistant', content: `Answer ${index}` }],
      provenance: { sourceType: 'conversation', conversationId },
    }));
    const snapshot = buildDatasetSnapshot({
      project: { id: project.id, title: project.title, goal: project.goal, method: project.method, baseModel: project.base_model },
      examples,
      consent: { accepted: true, rights: true, sensitive: true, local: true, trainerEndpoint: origin(trainer) },
    });
    const dataset = app.store.createTrainingDataset({
      project_id: project.id,
      format: 'sovereignai.training-dataset/v1',
      hash: snapshot.hash,
      manifest: snapshot.manifest,
      train_jsonl: snapshot.trainJsonl,
      eval_jsonl: snapshot.evalJsonl,
      train_count: snapshot.counts.train,
      eval_count: snapshot.counts.eval,
      consent: snapshot.manifest.consent,
    });
    const request = {
      trainer: { endpoint: origin(trainer) },
      method: 'sft-lora',
      base_model: 'local/base',
      hyperparameters: { epochs: 1 },
      consent: { accepted: true, datasetHash: dataset.hash, trainerEndpoint: origin(trainer) },
    };

    const uncertain = await api(base, 'POST', `/api/training/datasets/${dataset.id}/runs`, request);
    assert.equal(uncertain.status, 502);
    const run = app.store.listTrainingRuns(project.id)[0];
    assert.equal(run.status, 'unreachable');
    assert.equal(run.remote_job_id, null);

    const duplicate = await api(base, 'POST', `/api/training/datasets/${dataset.id}/runs`, request);
    assert.equal(duplicate.status, 409);
    assert.match(duplicate.body.error, /active training run/i);

    const recovered = await api(base, 'POST', `/api/training/runs/${run.id}/refresh`, {});
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.run.status, 'queued');
    assert.equal(recovered.body.run.remote_job_id, 'recovered-job');
    assert.deepEqual(submissions, [
      { runId: run.id, key: run.id },
      { runId: run.id, key: run.id },
    ]);
  } finally {
    await close(app.server);
    app.store.close();
    await close(trainer);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function addConversation(store, personaId, title, prompt, response) {
  const conversation = store.createConversation({ persona_id: personaId, title });
  store.addMessage({ conversation_id: conversation.id, role: 'user', content: prompt });
  store.addMessage({ conversation_id: conversation.id, role: 'assistant', content: response, provider: 'ollama', model: 'llama3.2:3b' });
  return conversation;
}

async function api(base, method, pathname, body) {
  const response = await fetch(base + pathname, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function origin(server) {
  return `http://127.0.0.1:${server.address().port}`;
}
