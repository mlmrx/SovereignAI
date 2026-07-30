import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  loadConfig,
  saveConfig,
  redactConfig,
  mergeConfigUpdate,
  withoutEnvironmentManagedFields,
  scrubPersistedEnvironmentSecrets,
  ConfigValidationError,
  VERSION,
} from './config.js';
import { ImportValidationError, ModelRecipeConflictError, openDb } from './db.js';
import { providers, getProvider, providerStatus } from './providers/index.js';
import { seedPersonas, shouldReplaceSeedPersonas } from './personas.js';
import { chunkText } from './rag/chunker.js';
import { retrieve, embedTexts } from './rag/retriever.js';
import { extractText } from './ingest/index.js';
import { handleChat } from './chat.js';
import { applySecurityHeaders, isJsonRequest, readJsonBody, sendJson, sseStart, HttpError } from './util.js';
import {
  ModelRecipeValidationError,
  normalizeModelRecipe,
  presentModelRecipe,
  unwrapPortableModelRecipe,
} from './model-recipes.js';
import { HfCatalogError, searchGgufModels, listGgufFiles } from './hf-catalog.js';
import { buildModelRecommendation } from './model-recommendation.js';
import { ChatImportError, importChatExport, supportedPlatforms as supportedChatPlatforms } from './chat-import/index.js';
import {
  TRAINING_DATASET_SCHEMA,
  TrainingValidationError,
  buildConversationExamples,
  buildDatasetSnapshot,
  normalizeHyperparameters,
  normalizeTrainingExample,
  validateDatasetSnapshot,
} from './training/dataset.js';
import {
  TrainerProtocolError,
  capabilities as trainerCapabilities,
  submit as submitTraining,
  refresh as refreshTraining,
  cancel as cancelTraining,
} from './training/client.js';

import { readPublicFile } from './static-assets.js';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function createApp(rootDir, { env = process.env } = {}) {
  const config = loadConfig(rootDir, { env });
  const store = openDb(path.join(rootDir, 'data'));
  seedPersonas(store);
  const startedAt = Date.now();
  // Emit HSTS only when the operator asserts the origin is served over HTTPS
  // (a TLS-terminating proxy). Never on the default plain-HTTP local install.
  const hsts = env.SOVEREIGN_HTTPS === '1' || env.SOVEREIGN_HTTPS === 'true';

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern: pattern.split('/').filter(Boolean), handler });

  // ---- status & providers ----
  route('GET', '/api/status', async () => ({
    name: config.name,
    version: VERSION,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    counts: store.getCounts(),
    defaults: config.defaults,
    setupComplete: Boolean(config.setupComplete),
  }));

  route('GET', '/api/providers', async () => providerStatus(config));

  route('GET', '/api/models', async ({ query }) => {
    if (query.provider) {
      const provider = getProvider(query.provider);
      const cfg = config.providers[query.provider];
      if (!provider.isConfigured(cfg)) throw new HttpError(400, `Provider "${query.provider}" is not configured`);
      return { provider: query.provider, models: await provider.listModels(cfg) };
    }
    const all = [];
    for (const provider of Object.values(providers)) {
      const cfg = config.providers[provider.id];
      if (!provider.isConfigured(cfg)) continue;
      try {
        all.push({ provider: provider.id, models: await provider.listModels(cfg) });
      } catch {
        all.push({ provider: provider.id, models: [], error: 'unreachable' });
      }
    }
    return all;
  });

  // ---- config ----
  route('GET', '/api/config', async () => redactConfig(config));
  route('PUT', '/api/config', async ({ body }) => {
    try {
      const persistedBase = scrubPersistedEnvironmentSecrets(loadConfig(rootDir, { env: {} }), env);
      const diskUpdate = withoutEnvironmentManagedFields(body, env);
      const merged = mergeConfigUpdate(persistedBase, diskUpdate);
      saveConfig(rootDir, merged);
      const effective = loadConfig(rootDir, { env });
      for (const key of Object.keys(config)) delete config[key];
      Object.assign(config, effective);
      return redactConfig(config);
    } catch (err) {
      if (err instanceof ConfigValidationError) throw new HttpError(400, err.message);
      throw err;
    }
  });

  // ---- personas ----
  route('GET', '/api/personas', async () => store.listPersonas());
  route('POST', '/api/personas', async ({ body }) => {
    if (!body.name || !body.system_prompt) throw new HttpError(400, 'name and system_prompt are required');
    return store.createPersona(body);
  });
  route('PUT', '/api/personas/:id', async ({ params, body }) => {
    const updated = store.updatePersona(params.id, body);
    if (!updated) throw new HttpError(404, 'Persona not found');
    return updated;
  });
  route('DELETE', '/api/personas/:id', async ({ params }) => {
    store.deletePersona(params.id);
    return { ok: true };
  });

  // ---- conversations ----
  route('GET', '/api/conversations', async () => store.listConversations());
  route('GET', '/api/conversations/:id', async ({ params }) => {
    const conversation = store.getConversation(params.id);
    if (!conversation) throw new HttpError(404, 'Conversation not found');
    return { ...conversation, messages: store.listMessages(params.id) };
  });
  const renameConversation = async ({ params, body }) => {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) throw new HttpError(400, 'title is required');
    if (title.length > 200) throw new HttpError(400, 'title must be at most 200 characters');
    const updated = store.renameConversation(params.id, title);
    if (!updated) throw new HttpError(404, 'Conversation not found');
    return updated;
  };
  route('PUT', '/api/conversations/:id', renameConversation);
  route('PATCH', '/api/conversations/:id', renameConversation);
  route('DELETE', '/api/conversations/:id', async ({ params }) => {
    store.deleteConversation(params.id);
    return { ok: true };
  });

  // Import chat history from another AI platform's export (ChatGPT, Claude,
  // Gemini, or the generic fallback shape). Sized like document uploads
  // (readJsonBody's 20 MB default) — a very large export is better handled
  // with `sovereign import-chat <file>`, which reads straight from disk.
  route('POST', '/api/chat-import', async ({ body }) => {
    if (typeof body.contentBase64 !== 'string' || !body.contentBase64) throw new HttpError(400, 'contentBase64 is required');
    if (body.platform !== undefined && !supportedChatPlatforms().includes(body.platform)) {
      throw new HttpError(400, `Unknown platform "${body.platform}". Supported: ${supportedChatPlatforms().join(', ')}`);
    }
    if (body.personaId !== undefined && body.personaId !== null && !store.getPersona(body.personaId)) {
      throw new HttpError(400, 'Unknown personaId');
    }
    let buffer;
    try {
      buffer = Buffer.from(body.contentBase64, 'base64');
    } catch {
      throw new HttpError(400, 'contentBase64 is not valid base64');
    }
    try {
      return importChatExport(store, buffer, { platform: body.platform, personaId: body.personaId ?? null });
    } catch (err) {
      if (err instanceof ChatImportError) throw new HttpError(400, err.message);
      throw err;
    }
  });

  // ---- memories ----
  route('GET', '/api/memories', async () => store.listMemories());
  route('POST', '/api/memories', async ({ body }) => {
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!content) throw new HttpError(400, 'content is required');
    if (content.length > 2000) throw new HttpError(400, 'content must be at most 2000 characters');
    return store.addMemory(content);
  });
  const updateMemory = async ({ params, body }) => {
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!content) throw new HttpError(400, 'content is required');
    if (content.length > 2000) throw new HttpError(400, 'content must be at most 2000 characters');
    const updated = store.updateMemory(params.id, content);
    if (!updated) throw new HttpError(404, 'Memory not found');
    return updated;
  };
  route('PUT', '/api/memories/:id', updateMemory);
  route('PATCH', '/api/memories/:id', updateMemory);
  route('DELETE', '/api/memories/:id', async ({ params }) => {
    store.deleteMemory(params.id);
    return { ok: true };
  });

  // ---- knowledge base ----
  route('GET', '/api/documents', async () => store.listDocuments());
  route('POST', '/api/documents', async ({ body }) => {
    if (!body.name) throw new HttpError(400, 'name is required');
    let text;
    if (typeof body.contentBase64 === 'string' && body.contentBase64) {
      text = extractText(body.name, Buffer.from(body.contentBase64, 'base64'));
    } else if (typeof body.content === 'string' && body.content.trim()) {
      text = extractText(body.name, Buffer.from(body.content, 'utf8'));
    } else {
      throw new HttpError(400, 'content or contentBase64 is required');
    }
    if (!text.trim()) throw new HttpError(422, `${body.name}: no extractable text`);
    const pieces = chunkText(text);
    const vectors = await embedTexts(config, pieces);
    const chunks = pieces.map((content, i) => ({ content, embedding: vectors?.[i] ?? null }));
    return store.addDocument({ name: body.name, size: text.length, chunks, embedded: Boolean(vectors) });
  });

  // ---- Model Studio: owned, portable Ollama configuration recipes ----
  const normalizeRecipe = (body, existing = null) => {
    try {
      return normalizeModelRecipe(unwrapPortableModelRecipe(body), { existing, strict: true });
    } catch (err) {
      if (err instanceof ModelRecipeValidationError) throw new HttpError(400, err.message);
      throw err;
    }
  };
  const saveRecipe = (action) => {
    try {
      return action();
    } catch (err) {
      if (err instanceof ModelRecipeConflictError) throw new HttpError(409, err.message);
      throw err;
    }
  };
  const presentRecipe = (recipe) => presentModelRecipe(recipe, { ollamaBaseUrl: config.providers.ollama.baseUrl });
  const buildRecipe = async (recipe) => {
    const cfg = config.providers.ollama;
    if (!providers.ollama.isConfigured(cfg)) throw new HttpError(400, 'Ollama is not configured');
    try {
      return await providers.ollama.createModel(cfg, recipe);
    } catch (err) {
      throw new HttpError(502, err.message);
    }
  };

  route('GET', '/api/model-recipes', async () => store.listModelRecipeSummaries());
  route('POST', '/api/model-recipes', async ({ body }) => {
    const recipe = normalizeRecipe(body);
    return presentRecipe(saveRecipe(() => store.createModelRecipe(recipe)));
  });
  route('GET', '/api/model-recipes/:id', async ({ params }) => {
    const recipe = store.getModelRecipe(params.id);
    if (!recipe) throw new HttpError(404, 'Model recipe not found');
    return presentRecipe(recipe);
  });
  route('PUT', '/api/model-recipes/:id', async ({ params, body }) => {
    const existing = store.getModelRecipe(params.id);
    if (!existing) throw new HttpError(404, 'Model recipe not found');
    const recipe = normalizeRecipe(body, existing);
    return presentRecipe(saveRecipe(() => store.updateModelRecipe(params.id, recipe)));
  });
  route('DELETE', '/api/model-recipes/:id', async ({ params }) => {
    const result = store.deleteModelRecipe(params.id);
    if (!result.changes) throw new HttpError(404, 'Model recipe not found');
    return { ok: true };
  });
  route('POST', '/api/model-recipes/:id/build', async ({ params }) => {
    const recipe = store.getModelRecipe(params.id);
    if (!recipe) throw new HttpError(404, 'Model recipe not found');
    const result = await buildRecipe(recipe);
    const saved = store.markModelRecipeBuilt(params.id, { expected: recipe });
    if (!saved) {
      const current = store.getModelRecipe(params.id);
      const reason = current ? 'changed' : 'was deleted';
      throw new HttpError(
        409,
        `Ollama created artifact "${recipe.name}", but the recipe ${reason} during the build and was not marked as current`
      );
    }
    const presented = presentRecipe(saved);
    return { ...result, recipe: presented, portable: presented.portable, modelfile: presented.modelfile, ownership: presented.ownership };
  });

  // Browse open-weight GGUF repos on Hugging Face to help fill in a recipe's
  // base model. Read-only metadata lookups against a fixed host — no weights
  // pass through this server; a build still pulls directly from Hugging Face
  // to the configured Ollama endpoint.
  const catalogRoute = (handler) => async (args) => {
    try {
      return await handler(args);
    } catch (err) {
      if (err instanceof HfCatalogError) throw new HttpError(err.status, err.message);
      throw err;
    }
  };
  route('GET', '/api/model-catalog/search', catalogRoute(async ({ query }) => ({
    results: await searchGgufModels(query.q),
  })));
  route('GET', '/api/model-catalog/files', catalogRoute(async ({ query }) => ({
    files: await listGgufFiles(query.repo),
  })));

  // Heuristic guidance: what model size/quant should run comfortably here,
  // and whether the workspace's training investment is worth an actual LoRA
  // run yet. See model-recommendation.js for the (pure, unit-tested) rules.
  route('GET', '/api/model-recommendation', async () => {
    const documents = store.listDocuments();
    const counts = store.getCounts();
    const { maxTrainCount } = store.getFineTuningReadiness();
    return buildModelRecommendation({
      totalMemoryBytes: os.totalmem(),
      endpointLocal: loopbackUrl(config.providers.ollama.baseUrl),
      corpus: {
        documents: counts.documents,
        totalDocumentChars: documents.reduce((sum, doc) => sum + (Number(doc.size) || 0), 0),
        memories: counts.memories,
      },
      maxTrainCount,
    });
  });

  // Compatibility endpoint used by the setup wizard. Successful builds are
  // persisted/upserted so even a legacy one-click build has an owned blueprint.
  route('POST', '/api/create-model', async ({ body }) => {
    const recipe = normalizeRecipe(body);
    const result = await buildRecipe(recipe);
    const saved = saveRecipe(() => store.upsertModelRecipeByName(recipe));
    const built = store.markModelRecipeBuilt(saved.id);
    const presented = presentRecipe(built);
    return { ...result, recipe: presented, portable: presented.portable, modelfile: presented.modelfile, ownership: presented.ownership };
  });

  // ---- Fine-Tuning Studio: consented datasets + user-owned trainer ----
  const activeTrainingStatuses = new Set([
    'preparing', 'uploading', 'queued', 'running', 'evaluating', 'exporting', 'cancel_requested', 'unreachable',
  ]);
  const terminalTrainingStatuses = new Set(['succeeded', 'failed', 'cancelled']);
  const trainingConnection = () => ({
    baseUrl: config.training.baseUrl,
    authToken: config.training.authToken,
  });
  const trainingEndpoint = () => canonicalHttpUrl(config.training.baseUrl, 'training.baseUrl');
  const trainingDatasetSummary = ({ train_jsonl: _train, eval_jsonl: _eval, ...dataset }) => dataset;
  const trainingEvaluation = (run, dataset) => {
    const evidence = Boolean(dataset?.eval_count) && hasEvaluationEvidence(run.metrics);
    return {
      metrics: run.metrics ?? {},
      evidence,
      decision: run.evaluation_decision ?? null,
      notes: run.evaluation_notes ?? '',
      holdout: {
        records: dataset?.eval_count ?? 0,
        split: dataset?.manifest?.split?.strategy ?? 'conversation-hash',
        leakageProtected: dataset?.manifest?.split?.leakageProtected === true,
      },
      comparisons: [],
      summary: evidence
        ? 'The self-hosted trainer returned evaluation-specific metrics for the frozen holdout. Test representative behavior in Chat before assignment.'
        : 'The trainer did not return identifiable holdout metrics. Approval is unavailable; reject the run or use the explicit skip-with-notes path.',
    };
  };
  const trainingDetail = (id) => {
    const project = store.getTrainingProject(id);
    if (!project) throw new HttpError(404, 'Fine-tuning project not found');
    const datasets = store.listTrainingDatasets(id).map(trainingDatasetSummary);
    const runs = store.listTrainingRuns(id);
    const detail = {
      project,
      examples: store.listTrainingExamples(id),
      datasets,
      runs,
      dataset: datasets[0] ?? null,
      run: runs[0] ?? null,
    };
    if (detail.run) detail.evaluation = trainingEvaluation(detail.run, store.getTrainingDataset(detail.run.dataset_id));
    return detail;
  };
  const requireTrainingProject = (id) => {
    const project = store.getTrainingProject(id);
    if (!project) throw new HttpError(404, 'Fine-tuning project not found');
    return project;
  };
  const requireTrainingDataset = (id) => {
    const dataset = store.getTrainingDataset(id);
    if (!dataset) throw new HttpError(404, 'Training dataset not found');
    return dataset;
  };
  const requireTrainingRun = (id) => {
    const run = store.getTrainingRun(id);
    if (!run) throw new HttpError(404, 'Training run not found');
    return run;
  };
  const assertTrainerEnabled = () => {
    if (!config.training.enabled) throw new HttpError(400, 'Enable and save the local/self-hosted trainer before starting training');
  };
  const assertTrainerEndpoint = (requested) => {
    if (requested === undefined || requested === null || requested === '') return;
    const normalized = canonicalHttpUrl(requested, 'trainer.endpoint');
    if (normalized !== trainingEndpoint()) {
      throw new HttpError(409, 'The requested trainer does not match the saved trainer configuration; save it first');
    }
  };
  const trainerJobUpdate = (job, dataset) => {
    const baseModel = trainingModelId(dataset.manifest?.project?.baseModel);
    const artifacts = job.artifacts ?? [];
    for (const artifact of artifacts) {
      const artifactBaseModel = trainingModelId(artifact.baseModel);
      if (baseModel && artifactBaseModel !== baseModel) {
        throw new TrainerProtocolError(
          `Trainer artifact base model "${artifactBaseModel || 'missing'}" does not match locked dataset base model "${baseModel}"`
        );
      }
    }
    const primaryArtifact = artifacts.find((candidate) => candidate.kind === 'merged-gguf') ?? artifacts[0] ?? null;
    const artifact = primaryArtifact ? { ...primaryArtifact, relatedArtifacts: artifacts } : null;
    const progress = normalizedTrainerProgress(job.progress, job.status);
    const stage = trainerStage(job.progress, job.status);
    return {
      status: job.status,
      progress,
      stage,
      metrics: job.metrics ?? {},
      artifact,
      error: job.error ?? null,
      completed_at: terminalTrainingStatuses.has(job.status) ? new Date().toISOString() : null,
    };
  };
  const trainingProtocolError = (err, fallback) => {
    if (err instanceof TrainerProtocolError || err instanceof TrainingValidationError) {
      return new HttpError(err instanceof TrainingValidationError ? 400 : 502, safeTrainingError(err));
    }
    return new HttpError(502, safeTrainingError(err, fallback));
  };

  route('GET', '/api/training/projects', async () => ({ projects: store.listTrainingProjects() }));
  route('POST', '/api/training/projects', async ({ body }) => {
    const input = normalizeTrainingProjectInput(body);
    if (input.target_persona_id && !store.getPersona(input.target_persona_id)) {
      throw new HttpError(400, 'Target persona not found');
    }
    const project = store.createTrainingProject(input);
    return trainingDetail(project.id);
  });
  route('GET', '/api/training/projects/:id', async ({ params }) => trainingDetail(params.id));
  route('PUT', '/api/training/projects/:id', async ({ params, body }) => {
    const existing = requireTrainingProject(params.id);
    const input = normalizeTrainingProjectInput({ ...existing, ...body });
    if (input.target_persona_id && !store.getPersona(input.target_persona_id)) {
      throw new HttpError(400, 'Target persona not found');
    }
    const locked = store.listTrainingDatasets(params.id).length > 0;
    if (locked && (input.base_model !== existing.base_model || input.method !== existing.method)) {
      throw new HttpError(409, 'Base model and training method are frozen after a dataset is locked; create a new project to change them');
    }
    store.updateTrainingProject(params.id, input);
    return trainingDetail(params.id);
  });
  route('DELETE', '/api/training/projects/:id', async ({ params }) => {
    requireTrainingProject(params.id);
    if (store.listTrainingRuns(params.id).some((run) => activeTrainingStatuses.has(run.status))) {
      throw new HttpError(409, 'Cancel the active training run before deleting this project');
    }
    store.deleteTrainingProject(params.id);
    return { ok: true };
  });

  route('GET', '/api/training/sources', async () => {
    const personasById = new Map(store.listPersonas().map((persona) => [persona.id, persona]));
    const sources = [];
    for (const conversation of store.listConversations()) {
      const messages = store.listMessages(conversation.id);
      const exampleCount = countConversationExamples(messages);
      if (exampleCount < 1) continue;
      const persona = personasById.get(conversation.persona_id);
      sources.push({
        type: 'conversation',
        id: conversation.id,
        label: conversation.title?.trim() || `Conversation ${conversation.id.slice(0, 8)}`,
        title: conversation.title ?? '',
        persona_name: persona?.name ?? null,
        message_count: messages.length,
        example_count: exampleCount,
        updated_at: conversation.updated_at,
      });
    }
    return { sources };
  });

  route('POST', '/api/training/projects/:id/prepare', async ({ params, body }) => {
    const project = requireTrainingProject(params.id);
    if (store.listTrainingDatasets(params.id).length) {
      throw new HttpError(409, 'This project already has a locked dataset; create a new project to prepare different data');
    }
    const consent = {
      ...requirePreparationConsent(body.consent),
      trainerEndpoint: trainingEndpoint(),
      trainerMode: loopbackUrl(trainingEndpoint()) ? 'local' : 'self-hosted',
      sourceConsentRecordedAt: new Date().toISOString(),
    };
    const refs = normalizeTrainingSources(body.sources, body.conversation_ids ?? body.conversationIds);
    const conversationById = new Map(store.listConversations().map((conversation) => [conversation.id, conversation]));
    const selected = refs.map(({ id }) => {
      const conversation = conversationById.get(id);
      if (!conversation) throw new HttpError(400, `Conversation source not found: ${id}`);
      return conversation;
    });
    const messagesByConversation = new Map(selected.map((conversation) => [
      conversation.id,
      store.listMessages(conversation.id),
    ]));
    let prepared;
    try {
      prepared = buildConversationExamples({
        conversations: selected,
        messagesByConversation,
        personas: store.listPersonas(),
      });
    } catch (err) {
      throw trainingProtocolError(err, 'Could not prepare conversation examples');
    }
    if (!prepared.length) throw new HttpError(422, 'The selected conversations contain no complete user/assistant examples');
    const examples = prepared.map((example) => {
      const system = example.messages.find((message) => message.role === 'system')?.content ?? '';
      const user = example.messages.find((message) => message.role === 'user')?.content ?? '';
      const assistant = [...example.messages].reverse().find((message) => message.role === 'assistant')?.content ?? '';
      return {
        id: crypto.randomUUID(),
        system,
        user,
        assistant,
        provenance: example.provenance,
        included: true,
        reviewed: false,
        risk_flags: example.riskFlags,
        content_hash: example.contentHash,
      };
    });
    store.replaceTrainingExamples(params.id, examples, {
      sourceConversations: selected.map((conversation) => conversation.id),
      consent,
    });
    return trainingDetail(project.id);
  });

  route('PUT', '/api/training/examples/:id', async ({ params, body }) => {
    const existing = store.getTrainingExample(params.id);
    if (!existing) throw new HttpError(404, 'Training example not found');
    if (store.listTrainingDatasets(existing.project_id).length) {
      throw new HttpError(409, 'This example belongs to an immutable locked dataset and can no longer be edited');
    }
    let messages = body.messages;
    if (!Array.isArray(messages)) {
      const system = optionalTrainingText(body.system ?? existing.system, 'system', 128 * 1024);
      messages = [
        ...(system.trim() ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: body.user ?? body.prompt ?? existing.user },
        { role: 'assistant', content: body.assistant ?? body.response ?? existing.assistant },
      ];
    }
    if (body.included !== undefined && typeof body.included !== 'boolean') {
      throw new HttpError(400, 'included must be a boolean');
    }
    const included = body.included === undefined ? existing.included : body.included === true;
    let normalized;
    try {
      normalized = normalizeTrainingExample({
        id: existing.id,
        messages,
        provenance: existing.provenance,
        state: included ? 'approved' : 'excluded',
      });
    } catch (err) {
      throw trainingProtocolError(err, 'Could not validate the training example');
    }
    if (normalized.messages.filter((message) => message.role !== 'system').length !== 2) {
      throw new HttpError(400, 'The v1 review editor accepts exactly one user message and one assistant response');
    }
    const updated = store.updateTrainingExample(existing.id, {
      system: normalized.messages.find((message) => message.role === 'system')?.content ?? '',
      user: normalized.messages.find((message) => message.role === 'user')?.content ?? '',
      assistant: [...normalized.messages].reverse().find((message) => message.role === 'assistant')?.content ?? '',
      included,
      reviewed: true,
      risk_flags: normalized.riskFlags,
      content_hash: normalized.contentHash,
    });
    return { example: updated };
  });

  route('POST', '/api/training/projects/:id/datasets', async ({ params, body }) => {
    const project = requireTrainingProject(params.id);
    if (store.listTrainingDatasets(params.id).length) {
      throw new HttpError(409, 'This project already has an immutable dataset snapshot');
    }
    const allExamples = store.listTrainingExamples(params.id);
    if (!allExamples.length) throw new HttpError(400, 'Prepare and review examples before locking a dataset');
    const requestedIds = body.example_ids ?? body.exampleIds;
    if (!Array.isArray(requestedIds) || !requestedIds.length) {
      throw new HttpError(400, 'example_ids must contain at least one reviewed example');
    }
    const selectedIds = new Set(requestedIds.map((id) => requiredTrainingText(id, 'example_ids entry', 512)));
    if (selectedIds.size !== requestedIds.length) throw new HttpError(400, 'example_ids must not contain duplicates');
    const knownIds = new Set(allExamples.map((example) => example.id));
    for (const id of selectedIds) if (!knownIds.has(id)) throw new HttpError(400, `Training example does not belong to this project: ${id}`);
    const includedIds = new Set(allExamples.filter((example) => example.included).map((example) => example.id));
    if (!setsEqual(selectedIds, includedIds)) {
      throw new HttpError(409, 'Locking must include every example currently marked for inclusion and no excluded examples');
    }
    const selected = allExamples.filter((example) => selectedIds.has(example.id));
    if (selected.some((example) => !example.reviewed)) {
      throw new HttpError(409, 'Review and save every included example before locking the dataset');
    }
    const approval = requireDatasetApproval(body.consent);
    if (!project.consent?.trainerEndpoint) throw new HttpError(409, 'Source consent is missing its trainer destination; prepare the review snapshot again');
    const consent = {
      ...project.consent,
      accepted: true,
      riskAccepted: approval.riskAccepted,
      trainerEndpoint: project.consent.trainerEndpoint,
      datasetApprovalRecordedAt: new Date().toISOString(),
    };
    let snapshot;
    try {
      const normalized = allExamples.map((example) => normalizeTrainingExample({
        id: example.id,
        messages: [
          ...(example.system ? [{ role: 'system', content: example.system }] : []),
          { role: 'user', content: example.user },
          { role: 'assistant', content: example.assistant },
        ],
        provenance: example.provenance,
        state: selectedIds.has(example.id) ? 'approved' : 'excluded',
      }));
      const selectedNormalized = normalized.filter((example) => example.state === 'approved');
      if (selectedNormalized.some((example) => example.riskFlags.some((flag) => flag.startsWith('secret_')))) {
        throw new HttpError(400, 'Remove detected credentials, API keys, and private keys before locking the dataset');
      }
      if (selectedNormalized.some((example) => example.riskFlags.length > 0) && !approval.riskAccepted) {
        throw new HttpError(400, 'Explicit acknowledgement of remaining personal-data and quality flags is required');
      }
      snapshot = buildDatasetSnapshot({
        project: {
          id: project.id,
          title: project.title,
          goal: project.goal,
          method: project.method,
          baseModel: project.base_model,
        },
        examples: normalized,
        consent,
      });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw trainingProtocolError(err, 'Could not build the immutable dataset');
    }
    const dataset = store.createTrainingDataset({
      project_id: project.id,
      format: TRAINING_DATASET_SCHEMA,
      hash: snapshot.hash,
      manifest: snapshot.manifest,
      train_jsonl: snapshot.trainJsonl,
      eval_jsonl: snapshot.evalJsonl,
      train_count: snapshot.counts.train,
      eval_count: snapshot.counts.eval,
      consent,
    });
    return { ...trainingDetail(project.id), dataset: trainingDatasetSummary(dataset) };
  });

  route('GET', '/api/training/datasets/:id/export', async ({ params }) => {
    const dataset = requireTrainingDataset(params.id);
    const project = requireTrainingProject(dataset.project_id);
    return {
      filename: `${safeFilename(project.title, 'fine-tuning-dataset')}-${dataset.hash.slice(0, 12)}`,
      manifest: dataset.manifest,
      trainJsonl: dataset.train_jsonl,
      evalJsonl: dataset.eval_jsonl,
      hash: dataset.hash,
    };
  });

  route('GET', '/api/training/capabilities', async () => {
    const endpoint = trainingEndpoint();
    if (!config.training.enabled) {
      return { available: false, configured: false, endpoint, detail: 'The local/self-hosted trainer is disabled.' };
    }
    try {
      const value = await trainerCapabilities(trainingConnection());
      return { ...value, available: true, configured: true, endpoint, detail: 'Trainer protocol and weight-training capability verified.' };
    } catch (err) {
      if (!(err instanceof TrainerProtocolError)) throw err;
      return { available: false, configured: true, endpoint, detail: err.message };
    }
  });

  route('POST', '/api/training/datasets/:id/runs', async ({ params, body }) => {
    assertTrainerEnabled();
    const dataset = requireTrainingDataset(params.id);
    const project = requireTrainingProject(dataset.project_id);
    assertTrainerEndpoint(body.trainer?.endpoint ?? body.endpoint);
    if (dataset.eval_count < 1 || !dataset.eval_jsonl) {
      throw new HttpError(409, 'Training requires at least two independent conversation groups so one can remain an untouched evaluation holdout');
    }
    let validatedSnapshot;
    try {
      validatedSnapshot = validateDatasetSnapshot(trainingSnapshot(dataset), { requireEvaluation: true });
    } catch (err) {
      throw trainingProtocolError(err, 'The locked dataset failed integrity validation');
    }
    const lockedProject = validatedSnapshot.manifest.project;
    if (!lockedProject || lockedProject.id !== project.id) throw new HttpError(409, 'Dataset project lineage is invalid');
    const lockedBaseModel = trainingModelId(lockedProject.baseModel);
    if (!lockedBaseModel) throw new HttpError(409, 'Dataset base-model lineage is invalid');
    if (body.base_model !== undefined && body.base_model !== lockedBaseModel) {
      throw new HttpError(409, 'The requested base model does not match the locked dataset');
    }
    if (body.method !== undefined && body.method !== lockedProject.method) {
      throw new HttpError(409, 'The requested training method does not match the locked dataset');
    }
    let hyperparameters;
    try {
      hyperparameters = normalizeHyperparameters(body.hyperparameters ?? {});
      const advertised = await trainerCapabilities(trainingConnection());
      if (!advertised.methods.includes(lockedProject.method)) {
        throw new HttpError(400, `Trainer does not support locked method "${lockedProject.method}"`);
      }
      if (Array.isArray(advertised.outputs) && advertised.outputs.length && !advertised.outputs.includes('gguf')) {
        throw new HttpError(400, 'Trainer does not advertise the required GGUF output');
      }
      if (Array.isArray(advertised.models) && advertised.models.length) {
        const supportedModel = advertised.models.find((model) => model?.id === lockedBaseModel);
        if (!supportedModel) throw new HttpError(400, `Trainer does not advertise support for base model "${lockedBaseModel}"`);
        if (Array.isArray(supportedModel.methods) && !supportedModel.methods.includes(lockedProject.method)) {
          throw new HttpError(400, `Trainer does not support ${lockedProject.method} for base model "${lockedBaseModel}"`);
        }
      }
      const datasetBytes = Buffer.byteLength(dataset.train_jsonl) + Buffer.byteLength(dataset.eval_jsonl);
      if (Number.isSafeInteger(advertised.limits?.maxDatasetBytes) && datasetBytes > advertised.limits.maxDatasetBytes) {
        throw new HttpError(400, `Dataset exceeds the trainer's ${advertised.limits.maxDatasetBytes}-byte limit`);
      }
      if (
        Number.isSafeInteger(advertised.limits?.maxSequenceLength) &&
        hyperparameters.maxSequenceLength > advertised.limits.maxSequenceLength
      ) {
        throw new HttpError(400, `Sequence length exceeds the trainer's ${advertised.limits.maxSequenceLength}-token limit`);
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw trainingProtocolError(err, 'Could not validate the trainer or hyperparameters');
    }
    const submissionConsent = requireSubmissionConsent(body.consent, {
      datasetHash: dataset.hash,
      trainerEndpoint: trainingEndpoint(),
      baseModel: lockedBaseModel,
      method: lockedProject.method,
      hyperparameters,
    });
    if (store.listTrainingRuns(project.id).some((run) => activeTrainingStatuses.has(run.status))) {
      throw new HttpError(409, 'This project already has an active training run');
    }
    const run = store.createTrainingRun({
      id: crypto.randomUUID(),
      project_id: project.id,
      dataset_id: dataset.id,
      endpoint: trainingEndpoint(),
      status: 'uploading',
      stage: 'Uploading immutable dataset blobs',
      hyperparameters,
      submission_consent: submissionConsent,
    });
    try {
      const job = await submitTraining(trainingConnection(), {
        runId: run.id,
        project: lockedProject,
        snapshot: validatedSnapshot,
        hyperparameters,
      });
      store.updateTrainingRun(run.id, {
        remote_job_id: job.id,
        ...trainerJobUpdate(job, dataset),
      });
      return trainingDetail(project.id);
    } catch (err) {
      const status = err instanceof TrainerProtocolError && err.status >= 400 && err.status < 500 ? 'failed' : 'unreachable';
      store.updateTrainingRun(run.id, {
        status,
        stage: status === 'unreachable' ? 'Trainer unreachable' : 'Trainer rejected the run',
        error: safeTrainingError(err),
        completed_at: status === 'failed' ? new Date().toISOString() : null,
      });
      throw trainingProtocolError(err, 'Could not submit the training run');
    }
  });

  route('POST', '/api/training/runs/:id/refresh', async ({ params }) => {
    assertTrainerEnabled();
    const run = requireTrainingRun(params.id);
    const dataset = requireTrainingDataset(run.dataset_id);
    if (terminalTrainingStatuses.has(run.status)) return trainingDetail(run.project_id);
    assertTrainerEndpoint(run.endpoint);
    try {
      if (!run.remote_job_id) {
        const lockedProject = dataset.manifest?.project;
        if (!lockedProject) throw new TrainerProtocolError('Locked dataset project lineage is missing');
        const submitted = await submitTraining(trainingConnection(), {
          runId: run.id,
          project: lockedProject,
          snapshot: trainingSnapshot(dataset),
          hyperparameters: run.hyperparameters,
        });
        store.updateTrainingRun(run.id, {
          remote_job_id: submitted.id,
          ...trainerJobUpdate(submitted, dataset),
        });
        return trainingDetail(run.project_id);
      }
      const job = await refreshTraining(trainingConnection(), run.remote_job_id);
      store.updateTrainingRun(run.id, trainerJobUpdate(job, dataset));
      return trainingDetail(run.project_id);
    } catch (err) {
      if (err instanceof TrainerProtocolError) {
        store.updateTrainingRun(run.id, { status: 'unreachable', stage: 'Trainer status unavailable', error: safeTrainingError(err) });
      }
      throw trainingProtocolError(err, 'Could not refresh the training run');
    }
  });

  route('POST', '/api/training/runs/:id/cancel', async ({ params }) => {
    assertTrainerEnabled();
    const run = requireTrainingRun(params.id);
    const dataset = requireTrainingDataset(run.dataset_id);
    if (terminalTrainingStatuses.has(run.status)) return trainingDetail(run.project_id);
    if (!run.remote_job_id) throw new HttpError(409, 'Training run has no remote trainer job id');
    assertTrainerEndpoint(run.endpoint);
    try {
      const job = await cancelTraining(trainingConnection(), run.remote_job_id);
      store.updateTrainingRun(run.id, trainerJobUpdate(job, dataset));
      return trainingDetail(run.project_id);
    } catch (err) {
      throw trainingProtocolError(err, 'Could not cancel the training run');
    }
  });

  route('POST', '/api/training/runs/:id/evaluate', async ({ params, body }) => {
    const run = requireTrainingRun(params.id);
    if (run.status !== 'succeeded') throw new HttpError(409, 'Training must succeed before evaluation review');
    const dataset = requireTrainingDataset(run.dataset_id);
    if (body.action === 'evaluate' && body.decision === undefined) {
      return { ...trainingDetail(run.project_id), evaluation: trainingEvaluation(run, dataset) };
    }
    const decision = requiredTrainingText(body.decision, 'decision', 32).toLowerCase();
    if (!['approved', 'rejected', 'skipped'].includes(decision)) {
      throw new HttpError(400, 'decision must be approved, rejected, or skipped');
    }
    const notes = optionalTrainingText(body.notes, 'notes', 64 * 1024);
    if (decision === 'approved' && !hasEvaluationEvidence(run.metrics)) {
      throw new HttpError(409, 'The trainer did not return evaluation-specific holdout metrics; approval is unavailable');
    }
    if (decision === 'skipped' && !notes.trim()) {
      throw new HttpError(400, 'Explain why behavioral evaluation was skipped before deployment');
    }
    const updated = store.updateTrainingRun(run.id, { evaluation_decision: decision, evaluation_notes: notes });
    return { ...trainingDetail(run.project_id), run: updated, evaluation: trainingEvaluation(updated, dataset) };
  });

  route('POST', '/api/training/runs/:id/deploy', async ({ params, body }) => {
    const run = requireTrainingRun(params.id);
    if (run.status !== 'succeeded') throw new HttpError(409, 'Training must succeed before deployment');
    if (!['approved', 'skipped'].includes(run.evaluation_decision)) {
      throw new HttpError(409, 'Record an approved evaluation or an explicit skip acknowledgement before deployment');
    }
    const artifact = run.artifact;
    if (!artifact || artifact.kind !== 'merged-gguf' || !artifact.ollamaModel || !artifact.ollamaDigest) {
      throw new HttpError(409, 'The trainer did not return a merged GGUF with an Ollama model name and digest attestation');
    }
    const dataset = requireTrainingDataset(run.dataset_id);
    if (trainingModelId(artifact.baseModel) !== trainingModelId(dataset.manifest?.project?.baseModel)) {
      throw new HttpError(409, 'Artifact base-model lineage does not match the locked dataset');
    }
    const requestedModel = body.model === undefined || body.model === ''
      ? artifact.ollamaModel
      : requiredTrainingText(body.model, 'model', 593);
    if (requestedModel !== artifact.ollamaModel) {
      throw new HttpError(409, `Use the trainer-attested Ollama model name "${artifact.ollamaModel}"`);
    }
    try {
      normalizeModelRecipe({ title: 'Trainer artifact', name: requestedModel, base: 'lineage-check' });
    } catch (err) {
      if (err instanceof ModelRecipeValidationError) throw new HttpError(400, `Invalid trainer artifact model name: ${err.message}`);
      throw err;
    }
    const ollamaConfig = config.providers.ollama;
    if (!providers.ollama.isConfigured(ollamaConfig)) {
      throw new HttpError(400, 'Configure and enable the Ollama endpoint before assigning the trained artifact');
    }
    let models;
    try {
      models = await providers.ollama.listModels(ollamaConfig);
    } catch (err) {
      throw new HttpError(502, `Could not verify the trained artifact at the configured Ollama endpoint: ${err.message}`);
    }
    const registered = models.find((model) => model.id === requestedModel);
    if (!registered) {
      throw new HttpError(409, `The trainer-reported model "${requestedModel}" is not registered at the configured Ollama endpoint`);
    }
    if (!registered.digest || registered.digest !== artifact.ollamaDigest) {
      throw new HttpError(409, `The registered Ollama model digest does not match the trainer attestation for "${requestedModel}"`);
    }
    const personaId = body.persona_id ?? body.personaId ?? null;
    if (!personaId) throw new HttpError(400, 'Choose a persona to assign the trained model');
    let persona = store.getPersona(personaId);
    if (!persona) throw new HttpError(404, 'Persona not found');
    persona = store.updatePersona(personaId, { provider: 'ollama', model: requestedModel });
    const stamp = new Date().toISOString();
    const updated = store.updateTrainingRun(run.id, {
      deployed_persona_id: persona?.id ?? null,
      deployed_at: stamp,
    });
    return {
      ...trainingDetail(run.project_id),
      run: updated,
      persona,
      deployment: {
        status: 'deployed',
        model: requestedModel,
        artifact,
        persona_id: persona?.id ?? null,
        endpoint: ollamaConfig.baseUrl,
        deployed_at: stamp,
      },
    };
  });

  route('DELETE', '/api/documents/:id', async ({ params }) => {
    store.deleteDocument(params.id);
    return { ok: true };
  });
  route('GET', '/api/search', async ({ query }) => {
    if (!query.q) throw new HttpError(400, 'q is required');
    return retrieve({ store, config, query: query.q });
  });

  // ---- simple ask (non-streaming; for integrations like ChatGPT Actions) ----
  route('POST', '/api/ask', async ({ body }) => {
    const persona = body.persona
      ? store.listPersonas().find((p) => p.name.toLowerCase() === String(body.persona).toLowerCase())
      : null;
    let answer = '';
    let meta = null;
    let usage = null;
    const sse = {
      send(event, data) {
        if (event === 'delta') answer += data.text;
        if (event === 'meta') meta = data;
        if (event === 'done') usage = data.usage;
        if (event === 'error') throw new HttpError(502, data.message);
      },
      end() {},
    };
    await handleChat({
      store,
      config,
      body: { message: body.message, personaId: persona?.id ?? body.personaId, conversationId: body.conversationId },
      sse,
    });
    return {
      answer,
      conversationId: meta?.conversationId ?? null,
      persona: meta?.persona ?? null,
      model: meta?.model ?? null,
      sources: meta?.sources ?? [],
      usage,
    };
  });

  // ---- data portability ----
  route('GET', '/api/export', async () => ({
    sovereignai: VERSION,
    exportedAt: new Date().toISOString(),
    data: store.exportAll(),
  }));
  route('POST', '/api/import', async ({ body }) => {
    if (!body.data) throw new HttpError(400, 'Invalid export file: missing data');
    try {
      const replacePersonas = shouldReplaceSeedPersonas(store, body.data);
      return { imported: store.importAll(body.data, { replacePersonas }) };
    } catch (err) {
      if (err instanceof ImportValidationError) throw new HttpError(400, err.message);
      throw err;
    }
  });

  const server = http.createServer(async (req, res) => {
    try {
      applySecurityHeaders(res, { hsts });
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      const segments = url.pathname.split('/').filter(Boolean);

      if (url.pathname.startsWith('/api/')) {
        const accessError = apiAccessError(req, config);
        if (accessError) {
          return sendJson(res, accessError.status, { error: accessError.message });
        }
        if (['POST', 'PUT', 'PATCH'].includes(req.method) && !isJsonRequest(req)) {
          return sendJson(res, 415, { error: 'Content-Type must be application/json' });
        }

        // chat is special-cased: it streams SSE
        if (req.method === 'POST' && url.pathname === '/api/chat') {
          const body = await readJsonBody(req);
          const sse = sseStart(res);
          const abort = new AbortController();
          const onDisconnect = () => {
            if (!res.writableEnded) abort.abort(new Error('Client disconnected'));
          };
          res.once('close', onDisconnect);
          try {
            await handleChat({ store, config, body, sse, signal: abort.signal });
          } catch (err) {
            if (!abort.signal.aborted && !res.destroyed) {
              sse.send('error', { message: err.message });
              sse.end();
            }
          } finally {
            res.off('close', onDisconnect);
          }
          return;
        }

        for (const r of routes) {
          if (r.method !== req.method) continue;
          const params = matchRoute(r.pattern, segments);
          if (!params) continue;
          const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJsonBody(req) : {};
          const result = await r.handler({ params, body, query: Object.fromEntries(url.searchParams) });
          return sendJson(res, 200, result);
        }
        return sendJson(res, 404, { error: `No route: ${req.method} ${url.pathname}` });
      }

      serveStatic(url.pathname, res);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) sendJson(res, status, { error: err.message });
      else res.end();
    }
  });

  return { server, config, store };
}

function normalizeTrainingProjectInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Fine-tuning project must be an object');
  }
  const title = requiredTrainingText(value.title ?? value.name, 'title', 200).trim();
  const goal = requiredTrainingText(value.goal, 'goal', 20 * 1024).trim();
  const baseModel = requiredTrainingText(value.base_model ?? value.baseModel ?? value.base, 'base_model', 2048).trim();
  if (/[\r\n\0]/.test(baseModel)) throw new HttpError(400, 'base_model must be a single-line model identifier');
  const method = requiredTrainingText(value.method ?? 'sft-qlora', 'method', 64).toLowerCase();
  if (!['sft-lora', 'sft-qlora'].includes(method)) throw new HttpError(400, 'method must be sft-lora or sft-qlora');
  const persona = value.target_persona_id ?? value.targetPersonaId ?? value.persona_id ?? null;
  const targetPersonaId = persona === null || persona === ''
    ? null
    : requiredTrainingText(persona, 'target_persona_id', 512);
  return {
    title,
    goal,
    base_model: baseModel,
    target_persona_id: targetPersonaId,
    method,
  };
}

function normalizeTrainingSources(sources, conversationIds) {
  let values = sources;
  if (!Array.isArray(values)) {
    if (!Array.isArray(conversationIds)) throw new HttpError(400, 'sources must contain at least one conversation');
    values = conversationIds.map((id) => ({ type: 'conversation', id }));
  }
  if (values.length < 1 || values.length > 1000) {
    throw new HttpError(400, 'Select between 1 and 1000 conversation sources');
  }
  const seen = new Set();
  return values.map((source, index) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new HttpError(400, `sources[${index}] must be an object`);
    }
    const type = requiredTrainingText(source.type ?? 'conversation', `sources[${index}].type`, 64).toLowerCase();
    if (type !== 'conversation') throw new HttpError(400, 'The local v1 workflow accepts conversation sources only');
    const id = requiredTrainingText(source.id, `sources[${index}].id`, 512);
    if (seen.has(id)) throw new HttpError(400, `Conversation source was selected more than once: ${id}`);
    seen.add(id);
    return { type, id };
  });
}

function requirePreparationConsent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'consent confirmations are required');
  }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 64 * 1024) throw new HttpError(400, 'consent metadata is too large');
  const requirements = [
    [['rights', 'dataRights', 'data_rights', 'right_to_train'], 'Confirm that you have the right to train on the selected content'],
    [['sensitive', 'sensitiveReview', 'sensitive_review'], 'Confirm that you will review secrets and personal data'],
    [['local', 'trainerDestination', 'trainer_destination', 'destination'], 'Confirm the configured trainer destination'],
  ];
  for (const [keys, message] of requirements) {
    if (!consentAccepted(value, keys)) throw new HttpError(400, message);
  }
  return JSON.parse(encoded);
}

function requireDatasetApproval(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Final dataset approval is required');
  }
  if (value.accepted !== true) throw new HttpError(400, 'consent.accepted must be true to lock the dataset');
  return {
    accepted: true,
    riskAccepted: consentAccepted(value, ['riskAccepted', 'risk_accepted', 'risk']),
  };
}

function requireSubmissionConsent(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.accepted !== true) {
    throw new HttpError(400, 'Explicit training-run consent is required');
  }
  if (value.datasetHash !== expected.datasetHash) throw new HttpError(409, 'Training consent does not match the locked dataset hash');
  if (canonicalHttpUrl(value.trainerEndpoint, 'consent.trainerEndpoint') !== expected.trainerEndpoint) {
    throw new HttpError(409, 'Training consent does not match the configured trainer endpoint');
  }
  return {
    accepted: true,
    acceptedAt: new Date().toISOString(),
    datasetHash: expected.datasetHash,
    trainerEndpoint: expected.trainerEndpoint,
    baseModel: expected.baseModel,
    method: expected.method,
    hyperparameters: expected.hyperparameters,
  };
}

function consentAccepted(value, keys) {
  return keys.some((key) => value?.[key] === true);
}

function countConversationExamples(messages) {
  let waitingForAssistant = false;
  let count = 0;
  for (const message of messages) {
    const content = typeof message?.content === 'string' ? message.content.trim() : '';
    if (message?.role === 'user') {
      waitingForAssistant = Boolean(content);
    } else if (message?.role === 'assistant' && waitingForAssistant && content) {
      count += 1;
      waitingForAssistant = false;
    }
  }
  return count;
}

function trainingSnapshot(dataset) {
  return {
    hash: dataset.hash,
    manifest: dataset.manifest,
    trainJsonl: dataset.train_jsonl,
    evalJsonl: dataset.eval_jsonl,
    counts: { train: dataset.train_count, eval: dataset.eval_count },
  };
}

function trainingModelId(value) {
  if (typeof value === 'string') return value;
  return value && typeof value === 'object' && !Array.isArray(value) && typeof value.id === 'string'
    ? value.id
    : null;
}

function normalizedTrainerProgress(value, status) {
  if (status === 'succeeded') return 1;
  let progress = null;
  if (typeof value === 'number' && Number.isFinite(value)) progress = value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const candidate of [value.fraction, value.progress, value.value, value.percent]) {
      if (typeof candidate === 'number' && Number.isFinite(candidate)) {
        progress = candidate;
        if (candidate === value.percent || candidate > 1) progress /= 100;
        break;
      }
    }
    const completed = Number.isFinite(value.current) ? value.current : value.completed;
    if (progress === null && Number.isFinite(completed) && Number.isFinite(value.total) && value.total > 0) {
      progress = completed / value.total;
    }
  }
  return progress === null ? null : Math.max(0, Math.min(1, progress));
}

function trainerStage(value, status) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const candidate of [value.stage, value.message, value.detail]) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().slice(0, 1024);
    }
  }
  return String(status || 'training').replace(/_/g, ' ').slice(0, 1024);
}

function hasEvaluationEvidence(metrics) {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) return false;
  return Object.entries(metrics).some(([key, value]) => {
    if (/eval|validation|holdout/i.test(key)) {
      return typeof value === 'number' ? Number.isFinite(value) : value !== null && value !== '';
    }
    return value && typeof value === 'object' && !Array.isArray(value) && hasEvaluationEvidence(value);
  });
}

function canonicalHttpUrl(value, label) {
  const raw = requiredTrainingText(value, label, 2048).trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, `${label} must be a valid HTTP(S) URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError(400, `${label} must use http or https`);
  if (url.username || url.password) throw new HttpError(400, `${label} must not contain credentials`);
  if (url.search || url.hash) throw new HttpError(400, `${label} must not contain a query string or fragment`);
  return url.toString().replace(/\/+$/, '');
}

function loopbackUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/\.$/, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

function requiredTrainingText(value, label, max) {
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be a string`);
  if (!value.trim()) throw new HttpError(400, `${label} is required`);
  if (value.length > max) throw new HttpError(400, `${label} must be at most ${max} characters`);
  if (value.includes('\0')) throw new HttpError(400, `${label} must not contain null bytes`);
  return value;
}

function optionalTrainingText(value, label, max) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be a string`);
  if (value.length > max) throw new HttpError(400, `${label} must be at most ${max} characters`);
  if (value.includes('\0')) throw new HttpError(400, `${label} must not contain null bytes`);
  return value;
}

function setsEqual(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function safeFilename(value, fallback) {
  const normalized = String(value ?? '').trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function safeTrainingError(error, fallback = 'Trainer request failed') {
  return String(error?.message || fallback)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, '[REDACTED_PRIVATE_KEY]')
    .replace(/\b(?:Bearer\s+|sk-|gh[pousr]_|xox[baprs]-)[A-Za-z0-9._-]{8,}/gi, '[REDACTED_CREDENTIAL]')
    .replace(/\b(password|passwd|api[_ -]?key|access[_ -]?token|secret)\s*[:=]\s*[^\s,;]{4,}/gi, '$1=[REDACTED]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 4096);
}

function matchRoute(pattern, segments) {
  if (pattern.length !== segments.length) return null;
  const params = {};
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i].startsWith(':')) params[pattern[i].slice(1)] = decodeURIComponent(segments[i]);
    else if (pattern[i] !== segments[i]) return null;
  }
  return params;
}

function apiAccessError(req, config) {
  if (config.authToken) {
    if (matchesBearer(req.headers.authorization, config.authToken)) return null;
    return { status: 401, message: 'Unauthorized: valid bearer token required' };
  }

  const remote = req.socket.remoteAddress ?? '';
  const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (!isLocal) return { status: 403, message: 'Remote API access requires a configured bearer token' };
  if (!trustedLoopbackHost(req.headers.host)) return { status: 403, message: 'Untrusted Host header' };
  if (!safeBrowserOrigin(req.headers.origin, req.headers.host)) return { status: 403, message: 'Cross-origin API access denied' };
  return null;
}

function matchesBearer(header, token) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function trustedLoopbackHost(host) {
  if (typeof host !== 'string' || !host) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname.toLowerCase().replace(/\.$/, '');
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
  } catch {
    return false;
  }
}

function safeBrowserOrigin(origin, host) {
  if (origin === undefined) return true; // CLI, IDE, MCP bridge, and other non-browser clients
  if (typeof origin !== 'string' || typeof host !== 'string') return false;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol === 'chrome-extension:' || parsed.protocol === 'moz-extension:') return true;
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function serveStatic(pathname, res) {
  let rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  let body = readPublicFile(rel);
  if (body === null) {
    // SPA fallback
    rel = 'index.html';
    body = readPublicFile(rel);
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(rel)] ?? 'application/octet-stream' });
  res.end(body ?? '');
}

export function startServer(rootDir, { host, port, env = process.env } = {}) {
  const app = createApp(rootDir, { env });
  const listenHost = host ?? app.config.host;
  const listenPort = port ?? app.config.port;
  return new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(listenPort, listenHost, () => resolve({ ...app, host: listenHost, port: listenPort }));
  });
}
