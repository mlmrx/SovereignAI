import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ModelRecipeConflictError, openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import {
  ModelRecipeValidationError,
  normalizeModelRecipe,
  portableModelRecipe,
  renderModelfile,
  unwrapPortableModelRecipe,
} from '../src/model-recipes.js';

const fullRecipe = {
  title: 'Deterministic analyst',
  name: 'acme/analyst:v1',
  base: 'llama3.2:latest',
  system: 'Use evidence and say when you are uncertain.',
  parameters: {
    temperature: 0.2,
    num_ctx: 8192,
    top_k: 30,
    top_p: 0.85,
    min_p: 0.05,
    repeat_last_n: 128,
    repeat_penalty: 1.15,
    seed: 42,
    num_predict: 2048,
    stop: ['<END>', 'User:'],
  },
  template: '{{ .System }}\n{{ .Prompt }}\n{{ .Response }}',
  license: 'For use by the owner.',
  messages: [
    { role: 'user', content: 'What is known?' },
    { role: 'assistant', content: 'Here is the evidence.' },
  ],
  quantize: 'q4_K_M',
};

test('model recipes normalize to a portable, truthful Ollama blueprint', () => {
  const recipe = normalizeModelRecipe(fullRecipe);
  const portable = portableModelRecipe(recipe);
  const modelfile = renderModelfile(recipe);

  assert.equal(portable.format, 'sovereignai.model-recipe');
  assert.equal(portable.version, 1);
  assert.deepEqual(portable.recipe.parameters.stop, ['<END>', 'User:']);
  assert.match(modelfile, /^# SovereignAI portable model blueprint/m);
  assert.match(modelfile, /^FROM llama3\.2:latest$/m);
  assert.match(modelfile, /^PARAMETER temperature 0\.2$/m);
  assert.match(modelfile, /^PARAMETER stop "<END>"$/m);
  assert.match(modelfile, /^SYSTEM """Use evidence/m);
  assert.match(modelfile, /^MESSAGE user """What is known\?"""$/m);
  assert.match(modelfile, /does not perform weight training/);
  assert.match(modelfile, /quantize q4_K_M \(creates a derived quantized artifact/);
  assert.deepEqual(unwrapPortableModelRecipe(portable), portable.recipe);
  assert.throws(
    () => unwrapPortableModelRecipe({ ...portable, format: 'other.recipe' }),
    /format must be "sovereignai\.model-recipe"/
  );
  assert.throws(
    () => unwrapPortableModelRecipe({ ...portable, version: 2 }),
    /Unsupported model recipe version: 2/
  );
});

test('model recipes whitelist and bound every advanced setting', () => {
  assert.throws(
    () => normalizeModelRecipe({ ...fullRecipe, parameters: { frequency_penalty: 1 } }),
    /Unsupported model parameter: frequency_penalty/
  );
  assert.throws(
    () => normalizeModelRecipe({ ...fullRecipe, parameters: { temperature: 2.1 } }),
    /temperature must be between 0 and 2/
  );
  assert.throws(
    () => normalizeModelRecipe({ ...fullRecipe, parameters: { num_ctx: 1.5 } }),
    /num_ctx must be an integer/
  );
  assert.throws(
    () => normalizeModelRecipe({ ...fullRecipe, parameters: { stop: 'not-an-array' } }),
    /stop must be an array/
  );
  assert.throws(
    () => normalizeModelRecipe({ ...fullRecipe, name: '../escape' }),
    ModelRecipeValidationError
  );
  assert.throws(
    () => normalizeModelRecipe({ ...fullRecipe, system: 'unsafe """ terminator' }),
    /cannot be represented safely in a Modelfile/
  );
});

test('artifact names follow Ollama host, namespace, model, and tag grammar', () => {
  const qualified = normalizeModelRecipe({
    ...fullRecipe,
    name: '_registry:5000/_team/_analyst.v2:_private-tag',
  });
  assert.equal(qualified.name, '_registry:5000/_team/_analyst.v2:_private-tag');
  assert.equal(normalizeModelRecipe({ ...fullRecipe, name: '_local_model:latest' }).name, '_local_model:latest');

  const longestHost = `${'h'.repeat(350)}/namespace/model:tag`;
  assert.equal(normalizeModelRecipe({ ...fullRecipe, name: longestHost }).name, longestHost);

  const invalid = [
    ['acme.team/model:tag', /namespace contains unsupported characters/],
    ['one/two/three/model:tag', /at most host, namespace, and model/],
    [`${'h'.repeat(351)}/namespace/model:tag`, /host must be 1-350 characters/],
    [`${'n'.repeat(81)}/model:tag`, /namespace must be 1-80 characters/],
    [`${'m'.repeat(81)}:tag`, /model must be 1-80 characters/],
    [`model:${'t'.repeat(81)}`, /tag must be 1-80 characters/],
    ['-model:tag', /model contains unsupported characters/],
  ];
  for (const [name, error] of invalid) {
    assert.throws(() => normalizeModelRecipe({ ...fullRecipe, name }), error, name);
  }
});

test('strict recipe inputs reject unknown fields while internal rows and legacy aliases remain compatible', () => {
  assert.throws(
    () => normalizeModelRecipe({ ...fullRecipe, paramters: {} }, { strict: true }),
    /Unsupported model recipe field: paramters/
  );
  assert.throws(
    () => normalizeModelRecipe({
      ...fullRecipe,
      messages: [{ role: 'user', content: 'Hello', unexpected: true }],
    }, { strict: true }),
    /Unsupported messages\[0\] field: unexpected/
  );

  const legacy = normalizeModelRecipe({
    title: 'Legacy aliases',
    model: '_legacy:latest',
    base_model: 'llama3.2',
    system_prompt: 'Keep compatibility.',
  }, { strict: true });
  assert.equal(legacy.name, '_legacy:latest');
  assert.equal(legacy.base, 'llama3.2');
  assert.equal(legacy.system, 'Keep compatibility.');

  const internal = normalizeModelRecipe({
    ...fullRecipe,
    id: 'internal-id',
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    last_built_at: null,
  });
  assert.equal(internal.name, fullRecipe.name);

  const portable = portableModelRecipe(fullRecipe);
  assert.throws(
    () => unwrapPortableModelRecipe({ ...portable, recipe: { ...portable.recipe, id: 'not-core' } }),
    /Unsupported portable recipe core field: id/
  );
  assert.throws(
    () => unwrapPortableModelRecipe({
      ...portable,
      recipe: {
        ...portable.recipe,
        messages: [{ role: 'user', content: 'Hello', unexpected: true }],
      },
    }),
    /Unsupported messages\[0\] field: unexpected/
  );
});

test('SQLite owns model recipe CRUD and export/import roundtrips structured settings', () => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-recipes-db-'));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-recipes-db-'));
  const first = openDb(firstRoot);
  const second = openDb(secondRoot);
  try {
    const created = first.createModelRecipe(fullRecipe);
    assert.ok(created.id);
    assert.deepEqual(created.parameters, fullRecipe.parameters);
    assert.deepEqual(created.messages, fullRecipe.messages);
    assert.throws(
      () => first.createModelRecipe({ ...fullRecipe, title: 'Duplicate', name: fullRecipe.name.toUpperCase() }),
      ModelRecipeConflictError
    );

    const updated = first.updateModelRecipe(created.id, { title: 'Updated analyst', parameters: { temperature: 0 } });
    assert.equal(updated.title, 'Updated analyst');
    assert.equal(updated.parameters.temperature, 0);
    assert.equal(updated.name, fullRecipe.name);
    assert.equal(first.markModelRecipeBuilt(created.id).last_built_at.length > 10, true);

    const dump = first.exportAll();
    assert.equal(dump.model_recipes.length, 1);
    assert.equal(typeof dump.model_recipes[0].parameters, 'object');
    const counts = second.importAll(dump);
    assert.equal(counts.model_recipes, 1);
    assert.deepEqual(second.getModelRecipe(created.id).parameters, { temperature: 0 });

    const duplicateNames = structuredClone(dump);
    duplicateNames.model_recipes.push({
      ...duplicateNames.model_recipes[0],
      id: 'duplicate-artifact-name',
      name: duplicateNames.model_recipes[0].name.toUpperCase(),
    });
    assert.throws(() => second.importAll(duplicateNames), /duplicate artifact name/);
    assert.equal(second.listModelRecipes().length, 1);

    dump.model_recipes[0].parameters = { arbitrary_backend_flag: true };
    assert.throws(() => second.importAll(dump), /Unsupported model parameter/);
    assert.equal(second.listModelRecipes().length, 1);

    assert.equal(first.deleteModelRecipe(created.id).changes, 1);
    assert.equal(first.getModelRecipe(created.id), null);
  } finally {
    first.close();
    second.close();
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
  }
});

test('Model Studio list returns lightweight summaries while item detail retains the full recipe', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-recipes-summary-'));
  const app = createApp(root, { env: {}, hardware: { detectGpu: async () => null } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const largeRecipe = {
    ...fullRecipe,
    name: 'large-summary-test:latest',
    system: 'S'.repeat(64 * 1024),
    messages: [{ role: 'user', content: 'M'.repeat(32 * 1024) }],
  };

  try {
    const createdResponse = await fetch(base + '/api/model-recipes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(largeRecipe),
    });
    assert.equal(createdResponse.status, 200);
    const created = await createdResponse.json();

    const list = await fetch(base + '/api/model-recipes').then((response) => response.json());
    assert.equal(list.length, 1);
    assert.deepEqual(Object.keys(list[0]).sort(), [
      'base',
      'created_at',
      'id',
      'last_built_at',
      'name',
      'quantize',
      'title',
      'updated_at',
    ]);
    assert.equal(list[0].id, created.id);
    assert.equal(list[0].base, largeRecipe.base);
    for (const field of ['system', 'parameters', 'template', 'license', 'messages', 'portable', 'modelfile', 'ownership']) {
      assert.equal(Object.hasOwn(list[0], field), false, field);
    }

    const detailResponse = await fetch(base + `/api/model-recipes/${created.id}`);
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();
    assert.equal(detail.system.length, largeRecipe.system.length);
    assert.deepEqual(detail.parameters, largeRecipe.parameters);
    assert.equal(detail.template, largeRecipe.template);
    assert.equal(detail.license, largeRecipe.license);
    assert.equal(detail.messages[0].content.length, largeRecipe.messages[0].content.length);
    assert.ok(detail.portable);
    assert.match(detail.modelfile, /^# SovereignAI portable model blueprint/m);
    assert.ok(detail.ownership);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    app.store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Model Studio API persists, builds, and exports the exact advanced Ollama recipe', async () => {
  const requests = [];
  const ollama = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({ url: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: body.model === 'unfinished:latest' ? 'writing manifest' : 'success' }));
    });
  });
  await new Promise((resolve) => ollama.listen(0, '127.0.0.1', resolve));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-recipes-api-'));
  const ollamaUrl = `http://127.0.0.1:${ollama.address().port}`;
  fs.writeFileSync(path.join(root, 'sovereign.config.json'), JSON.stringify({
    providers: { ollama: { enabled: true, baseUrl: ollamaUrl } },
    embeddings: { model: '' },
  }));
  const app = createApp(root, { env: {}, hardware: { detectGpu: async () => null } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const send = async (method, url, body = {}) => {
    const response = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  try {
    const typo = await send('POST', '/api/model-recipes', {
      ...fullRecipe,
      name: 'typo-fields:latest',
      paramters: { temperature: 0.1 },
    });
    assert.equal(typo.status, 400);
    assert.match(typo.body.error, /Unsupported model recipe field: paramters/);

    const legacyAliases = await send('POST', '/api/model-recipes', {
      title: 'Legacy field aliases',
      model: '_legacy-fields:latest',
      base_model: 'llama3.2',
      system_prompt: 'Legacy clients still work.',
    });
    assert.equal(legacyAliases.status, 200);
    assert.equal(legacyAliases.body.name, '_legacy-fields:latest');
    assert.equal((await send('DELETE', `/api/model-recipes/${legacyAliases.body.id}`)).status, 200);

    const portableCoreTypo = await send('POST', '/api/model-recipes', {
      format: 'sovereignai.model-recipe',
      version: 1,
      recipe: { ...fullRecipe, name: 'portable-typo:latest', paramters: {} },
    });
    assert.equal(portableCoreTypo.status, 400);
    assert.match(portableCoreTypo.body.error, /Unsupported portable recipe core field: paramters/);

    const wrongEnvelope = await send('POST', '/api/model-recipes', {
      format: 'not-sovereignai',
      version: 999,
      recipe: fullRecipe,
    });
    assert.equal(wrongEnvelope.status, 400);
    assert.match(wrongEnvelope.body.error, /format/);

    const created = await send('POST', '/api/model-recipes', fullRecipe);
    assert.equal(created.status, 200);
    assert.equal(created.body.name, fullRecipe.name);
    assert.equal(created.body.ownership.recipeStorage, 'local SQLite database');
    assert.equal(created.body.ownership.trainingPerformed, false);
    assert.equal(created.body.ownership.sourceWeightsChanged, false);
    assert.equal(created.body.ownership.artifactWeightsQuantized, true);
    assert.equal(created.body.ownership.weightsChanged, true);
    assert.equal(created.body.portable.recipe.quantize, 'q4_K_M');

    const duplicate = await send('POST', '/api/model-recipes', {
      ...fullRecipe,
      title: 'Duplicate artifact target',
      name: fullRecipe.name.toUpperCase(),
    });
    assert.equal(duplicate.status, 409);
    assert.match(duplicate.body.error, /already exists/);

    const invalid = await send('POST', '/api/model-recipes', {
      ...fullRecipe,
      name: 'invalid-settings',
      parameters: { top_p: 1.5 },
    });
    assert.equal(invalid.status, 400);
    assert.match(invalid.body.error, /top_p/);
    assert.equal(requests.length, 0);

    const built = await send('POST', `/api/model-recipes/${created.body.id}/build`);
    assert.equal(built.status, 200);
    assert.equal(built.body.model, fullRecipe.name);
    assert.ok(built.body.recipe.last_built_at);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0], {
      url: '/api/create',
      body: {
        model: fullRecipe.name,
        from: fullRecipe.base,
        stream: false,
        system: fullRecipe.system,
        parameters: fullRecipe.parameters,
        template: fullRecipe.template,
        license: fullRecipe.license,
        messages: fullRecipe.messages,
        quantize: fullRecipe.quantize,
      },
    });

    const unfinished = await send('POST', '/api/model-recipes', {
      title: 'Unfinished build',
      name: 'unfinished:latest',
      base: 'llama3.2',
    });
    assert.equal(unfinished.status, 200);
    const conflictingUpdate = await send('PUT', `/api/model-recipes/${unfinished.body.id}`, {
      name: fullRecipe.name.toUpperCase(),
    });
    assert.equal(conflictingUpdate.status, 409);
    assert.match(conflictingUpdate.body.error, /already exists/);
    const unfinishedBuild = await send('POST', `/api/model-recipes/${unfinished.body.id}/build`);
    assert.equal(unfinishedBuild.status, 502);
    assert.match(unfinishedBuild.body.error, /did not report terminal success/);
    const unfinishedSaved = await fetch(base + `/api/model-recipes/${unfinished.body.id}`).then((response) => response.json());
    assert.equal(unfinishedSaved.last_built_at, null);
    assert.equal((await send('DELETE', `/api/model-recipes/${unfinished.body.id}`)).status, 200);

    const legacy = await send('POST', '/api/create-model', {
      name: 'wizard-owned:latest',
      base: 'llama3.2',
      system: 'Stay local.',
    });
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.recipe.name, 'wizard-owned:latest');
    assert.equal(legacy.body.recipe.title, 'wizard-owned:latest');
    assert.equal(legacy.body.recipe.ownership.weightsChanged, false);
    assert.equal(legacy.body.recipe.ownership.artifactWeightsQuantized, false);
    await send('POST', '/api/create-model', {
      name: 'wizard-owned:latest',
      base: 'llama3.2',
      system: 'Stay local and concise.',
    });

    const list = await fetch(base + '/api/model-recipes').then((response) => response.json());
    assert.equal(list.filter((recipe) => recipe.name === 'wizard-owned:latest').length, 1);
    const wizardSummary = list.find((recipe) => recipe.name === 'wizard-owned:latest');
    assert.equal(Object.hasOwn(wizardSummary, 'system'), false);
    const wizardDetail = await fetch(base + `/api/model-recipes/${wizardSummary.id}`).then((response) => response.json());
    assert.equal(wizardDetail.system, 'Stay local and concise.');

    const exported = await fetch(base + '/api/export').then((response) => response.json());
    assert.equal(exported.data.model_recipes.length, 2);
    assert.equal(exported.data.model_recipes.some((recipe) => recipe.name === fullRecipe.name), true);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    app.store.close();
    await new Promise((resolve) => ollama.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Model Studio never marks a changed or deleted recipe as built from a stale snapshot', async () => {
  const queued = [];
  const waiters = [];
  const openResponses = new Set();
  const ollama = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const request = { body: JSON.parse(Buffer.concat(chunks).toString('utf8')), res };
      openResponses.add(request);
      const waiter = waiters.shift();
      if (waiter) waiter(request);
      else queued.push(request);
    });
  });
  const nextBuild = () => queued.length
    ? Promise.resolve(queued.shift())
    : new Promise((resolve) => waiters.push(resolve));
  const finishBuild = (request) => {
    if (!openResponses.delete(request) || request.res.writableEnded) return;
    request.res.writeHead(200, { 'content-type': 'application/json' });
    request.res.end(JSON.stringify({ status: 'success' }));
  };
  await new Promise((resolve) => ollama.listen(0, '127.0.0.1', resolve));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-recipes-race-'));
  fs.writeFileSync(path.join(root, 'sovereign.config.json'), JSON.stringify({
    providers: { ollama: { enabled: true, baseUrl: `http://127.0.0.1:${ollama.address().port}` } },
    embeddings: { model: '' },
  }));
  const app = createApp(root, { env: {}, hardware: { detectGpu: async () => null } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const send = async (method, url, body) => {
    const response = await fetch(base + url, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  try {
    const changing = await send('POST', '/api/model-recipes', {
      title: 'Changing recipe',
      name: 'before-build:latest',
      base: 'llama3.2',
      system: 'Before',
    });
    const changingBuildPromise = send('POST', `/api/model-recipes/${changing.body.id}/build`, {});
    const changingBuild = await nextBuild();
    assert.equal(changingBuild.body.model, 'before-build:latest');
    const changed = await send('PUT', `/api/model-recipes/${changing.body.id}`, {
      name: 'after-build:latest',
      system: 'After',
    });
    assert.equal(changed.status, 200);
    finishBuild(changingBuild);
    const staleResult = await changingBuildPromise;
    assert.equal(staleResult.status, 409);
    assert.match(staleResult.body.error, /changed during the build/);
    const current = await send('GET', `/api/model-recipes/${changing.body.id}`);
    assert.equal(current.body.name, 'after-build:latest');
    assert.equal(current.body.last_built_at, null);

    const deleting = await send('POST', '/api/model-recipes', {
      title: 'Deleting recipe',
      name: 'delete-during-build:latest',
      base: 'llama3.2',
    });
    const deletingBuildPromise = send('POST', `/api/model-recipes/${deleting.body.id}/build`, {});
    const deletingBuild = await nextBuild();
    assert.equal((await send('DELETE', `/api/model-recipes/${deleting.body.id}`)).status, 200);
    finishBuild(deletingBuild);
    const deletedResult = await deletingBuildPromise;
    assert.equal(deletedResult.status, 409);
    assert.match(deletedResult.body.error, /was deleted during the build/);
    assert.equal((await send('GET', `/api/model-recipes/${deleting.body.id}`)).status, 404);
  } finally {
    for (const request of [...openResponses]) finishBuild(request);
    await new Promise((resolve) => app.server.close(resolve));
    app.store.close();
    await new Promise((resolve) => ollama.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
