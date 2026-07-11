import crypto from 'node:crypto';
import { normalizeHyperparameters, TrainingValidationError, validateDatasetSnapshot } from './dataset.js';

export const TRAINER_PROTOCOL = 'sovereignai.trainer/v1';
export const TRAINING_JOB_SCHEMA = 'sovereignai.training-job/v1';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 5 * 60_000;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_BLOB_BYTES = 512 * 1024 * 1024;
const JOB_STATUSES = new Set(['queued', 'running', 'cancel_requested', 'cancelled', 'succeeded', 'failed']);
const TRAINING_METHODS = new Set(['sft-lora', 'sft-qlora']);
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const HEX_SHA256 = /^[a-f0-9]{64}$/;

export class TrainerProtocolError extends Error {
  constructor(message, { status = null, cause } = {}) {
    super(message, { cause });
    this.name = 'TrainerProtocolError';
    this.status = status;
  }
}

/** Read and validate the capabilities advertised by the configured trainer. */
export async function capabilities(config, options = {}) {
  const value = await requestJson(config, '/v1/capabilities', {
    method: 'GET',
    expectedStatuses: [200],
    ...requestOptions(options),
  });
  if (!isObject(value)) protocolFail('Trainer capabilities must be a JSON object');
  if (value.protocol !== TRAINER_PROTOCOL) {
    protocolFail(`Trainer protocol must be "${TRAINER_PROTOCOL}"`);
  }
  if (value.actualWeightTraining !== true) {
    protocolFail('Trainer must explicitly report actualWeightTraining: true');
  }
  if (!Array.isArray(value.methods) || value.methods.length === 0) {
    protocolFail('Trainer capabilities.methods must be a non-empty array');
  }
  const methods = value.methods.map((method, index) => shortIdentifier(method, `capabilities.methods[${index}]`));
  return boundedClone({ ...value, methods: [...new Set(methods)] }, 'trainer capabilities', MAX_JSON_BYTES);
}

/**
 * Upload immutable JSONL blobs, then submit an idempotent asynchronous job.
 * The manifest remains inline so the trainer can validate the blob digests.
 */
export async function submit(config, input, options = {}) {
  if (!isObject(input)) protocolFail('Training job input must be an object');
  const runId = jobId(input.runId, 'runId');
  const project = normalizeProject(input.project);
  const snapshot = normalizeSnapshot(input.snapshot ?? input.dataset);
  const hyperparameters = normalizeTrainerHyperparameters(input.hyperparameters ?? {});

  const trainBytes = Buffer.from(snapshot.trainJsonl, 'utf8');
  const evalBytes = Buffer.from(snapshot.evalJsonl, 'utf8');
  const train = makeBlobReference(trainBytes, snapshot.counts.train, snapshot.manifest.files?.train, 'train');
  const evaluation = makeBlobReference(evalBytes, snapshot.counts.eval, snapshot.manifest.files?.eval, 'eval');

  await ensureBlob(config, trainBytes, train, 'application/x-ndjson; charset=utf-8', options);
  await ensureBlob(config, evalBytes, evaluation, 'application/x-ndjson; charset=utf-8', options);

  const body = {
    schema: TRAINING_JOB_SCHEMA,
    runId,
    project: {
      id: project.id,
      ...(project.title ? { title: project.title } : {}),
    },
    method: project.method,
    baseModel: project.baseModel,
    dataset: {
      hash: snapshot.hash,
      manifest: snapshot.manifest,
      train,
      eval: evaluation,
    },
    hyperparameters,
    output: {
      preserveAdapter: true,
      mergedModel: true,
      format: 'gguf',
      quantization: 'q4_K_M',
    },
  };

  const value = await requestJson(config, '/v1/training/jobs', {
    method: 'POST',
    body,
    headers: { 'idempotency-key': runId },
    expectedStatuses: [200, 201, 202],
    ...requestOptions(options),
  });
  return normalizeJob(value);
}

/** Fetch the trainer's current view of an asynchronous job. */
export async function refresh(config, id, options = {}) {
  const remoteId = jobId(id, 'job id');
  const value = await requestJson(config, `/v1/training/jobs/${encodeURIComponent(remoteId)}`, {
    method: 'GET',
    expectedStatuses: [200],
    ...requestOptions(options),
  });
  return normalizeJob(value, { expectedId: remoteId });
}

/** Request cancellation. Cancellation remains asynchronous until confirmed. */
export async function cancel(config, id, options = {}) {
  const remoteId = jobId(id, 'job id');
  const value = await requestJson(config, `/v1/training/jobs/${encodeURIComponent(remoteId)}/cancel`, {
    method: 'POST',
    body: {},
    expectedStatuses: [200, 202],
    ...requestOptions(options),
  });
  const job = normalizeJob(value, { expectedId: remoteId });
  if (!['cancel_requested', 'cancelled', 'succeeded', 'failed'].includes(job.status)) {
    protocolFail(`Cancellation returned unexpected job status "${job.status}"`);
  }
  return job;
}

async function ensureBlob(config, bytes, reference, contentType, options) {
  const path = `/v1/blobs/${reference.digest}`;
  const cfg = normalizeConfig(config);
  const common = {
    fetchImpl: options.fetchImpl ?? options.fetch,
    signal: options.signal,
  };
  const head = await rawRequest(cfg, path, {
    method: 'HEAD',
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...common,
  });
  if (head.status === 200) return;
  if (head.status !== 404) throw await responseError(head, 'Trainer blob lookup failed');

  const response = await rawRequest(cfg, path, {
    method: 'PUT',
    body: bytes,
    headers: {
      'content-type': contentType,
      'content-length': String(bytes.length),
      'x-content-sha256': reference.digest,
    },
    timeoutMs: options.uploadTimeoutMs ?? options.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS,
    ...common,
  });
  if (![200, 201, 204].includes(response.status)) throw await responseError(response, 'Trainer blob upload failed');
  await readBoundedText(response, MAX_ERROR_BYTES);
}

async function requestJson(config, path, options) {
  const cfg = normalizeConfig(config);
  const response = await rawRequest(cfg, path, options);
  if (!options.expectedStatuses.includes(response.status)) throw await responseError(response, 'Trainer request failed');
  const type = response.headers.get('content-type') ?? '';
  if (!/\bapplication\/(?:[a-z0-9.+-]*\+)?json\b/i.test(type)) {
    protocolFail(`Trainer returned unsupported Content-Type "${type || 'missing'}"`, { status: response.status });
  }
  const text = await readBoundedText(response, options.maxResponseBytes ?? MAX_JSON_BYTES);
  if (!text) protocolFail('Trainer returned an empty JSON response', { status: response.status });
  try {
    return JSON.parse(text);
  } catch (cause) {
    protocolFail('Trainer returned invalid JSON', { status: response.status, cause });
  }
}

async function rawRequest(config, path, {
  method,
  headers = {},
  body,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof fetchImpl !== 'function') protocolFail('fetch is unavailable in this runtime');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60 * 60_000) {
    protocolFail('timeoutMs must be an integer from 1 to 3600000');
  }
  const url = `${config.baseUrl}${path}`;
  const requestHeaders = {
    accept: 'application/json',
    ...(config.authToken ? { authorization: `Bearer ${config.authToken}` } : {}),
    ...headers,
  };
  let requestBody = body;
  if (isObject(body) && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
    requestBody = JSON.stringify(body);
    requestHeaders['content-type'] = 'application/json';
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    return await fetchImpl(url, {
      method,
      headers: requestHeaders,
      body: requestBody,
      signal: combinedSignal,
      redirect: 'error',
    });
  } catch (cause) {
    if (cause instanceof TrainerProtocolError) throw cause;
    protocolFail(`Trainer ${method} request failed: ${safeErrorMessage(cause)}`, { cause });
  }
}

function normalizeConfig(config) {
  if (!isObject(config)) protocolFail('Trainer config must be an object');
  if (typeof config.baseUrl !== 'string' || !config.baseUrl.trim()) protocolFail('Trainer baseUrl is required');
  let url;
  try {
    url = new URL(config.baseUrl.trim());
  } catch (cause) {
    protocolFail('Trainer baseUrl must be a valid URL', { cause });
  }
  if (!['http:', 'https:'].includes(url.protocol)) protocolFail('Trainer baseUrl must use http or https');
  if (url.username || url.password) protocolFail('Trainer baseUrl must not contain credentials');
  if (url.search || url.hash) protocolFail('Trainer baseUrl must not contain a query string or fragment');
  const authToken = config.authToken ?? config.token ?? '';
  if (typeof authToken !== 'string' || authToken.length > 8192 || /[\r\n]/.test(authToken)) {
    protocolFail('Trainer authToken must be a valid header value');
  }
  return { baseUrl: url.toString().replace(/\/+$/, ''), authToken };
}

function normalizeProject(project) {
  if (!isObject(project)) protocolFail('project must be an object');
  const id = jobId(project.id, 'project.id');
  const method = shortIdentifier(project.method ?? 'sft-lora', 'project.method');
  if (!TRAINING_METHODS.has(method)) protocolFail(`project.method must be one of: ${[...TRAINING_METHODS].join(', ')}`);
  const baseModel = project.baseModel ?? project.base_model ?? project.baseRef ?? project.base_ref ?? project.base;
  const baseModelId = typeof baseModel === 'string' ? baseModel : baseModel?.id;
  if (typeof baseModelId !== 'string' || !baseModelId.trim() || baseModelId.length > 2048) {
    protocolFail('project.baseModel must be a model id string or an object with an id');
  }
  return {
    id,
    title: optionalString(project.title, 1000),
    method,
    baseModel: { id: baseModelId },
  };
}

function normalizeSnapshot(snapshot) {
  try {
    return validateDatasetSnapshot(snapshot, { requireEvaluation: true });
  } catch (err) {
    if (err instanceof TrainingValidationError) protocolFail(err.message, { cause: err });
    throw err;
  }
}

function normalizeTrainerHyperparameters(value) {
  try {
    return normalizeHyperparameters(value);
  } catch (err) {
    if (err instanceof TrainingValidationError) protocolFail(err.message, { cause: err });
    throw err;
  }
}

function makeBlobReference(bytes, records, expected, label) {
  if (bytes.length > MAX_BLOB_BYTES) protocolFail(`${label} JSONL exceeds ${MAX_BLOB_BYTES} bytes`);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (expected !== undefined) {
    if (!isObject(expected)) protocolFail(`snapshot.manifest.files.${label} must be an object`);
    if (expected.sha256 !== hash || expected.bytes !== bytes.length || expected.records !== records) {
      protocolFail(`${label} JSONL does not match its manifest metadata`);
    }
  }
  return { digest: `sha256:${hash}`, bytes: bytes.length, records };
}

function normalizeJob(value, { expectedId = null } = {}) {
  if (!isObject(value)) protocolFail('Trainer job response must be an object');
  const id = jobId(value.id ?? value.jobId, 'trainer job id');
  if (expectedId !== null && id !== expectedId) protocolFail(`Trainer returned job id "${id}" instead of "${expectedId}"`);
  if (!JOB_STATUSES.has(value.status)) {
    protocolFail(`Trainer returned unsupported job status "${String(value.status)}"`);
  }
  const out = { id, status: value.status };
  if (value.progress !== undefined) out.progress = boundedClone(value.progress, 'job progress', 128 * 1024);
  if (value.metrics !== undefined) out.metrics = boundedClone(value.metrics, 'job metrics', 512 * 1024);
  if (value.error !== undefined && value.error !== null) out.error = requiredString(value.error, 'job error', 16_384);

  const candidates = value.artifacts ?? (value.artifact ? [value.artifact] : []);
  if (!Array.isArray(candidates)) protocolFail('job artifacts must be an array');
  if (candidates.length > 32) protocolFail('job may return at most 32 artifacts');
  const artifacts = candidates.map(normalizeArtifact);
  if (artifacts.length) out.artifacts = artifacts;
  if (value.status === 'succeeded' && artifacts.length === 0) {
    protocolFail('A succeeded training job must return at least one verified artifact');
  }
  if (value.status === 'failed' && !out.error) protocolFail('A failed training job must include an error');
  return out;
}

function normalizeArtifact(value, index) {
  if (!isObject(value)) protocolFail(`artifacts[${index}] must be an object`);
  const kind = shortIdentifier(value.kind, `artifacts[${index}].kind`);
  const sha256 = sha256Value(value.sha256, `artifacts[${index}].sha256`);
  if (!isObject(value.baseModel)) protocolFail(`artifacts[${index}].baseModel must be an object`);
  const baseModel = { id: requiredString(value.baseModel.id, `artifacts[${index}].baseModel.id`, 2048) };
  const bytes = nonnegativeInteger(value.bytes, `artifacts[${index}].bytes`);
  const out = { kind, sha256, bytes, baseModel };
  const hasOllamaModel = value.ollamaModel !== undefined && value.ollamaModel !== null;
  const hasOllamaDigest = value.ollamaDigest !== undefined && value.ollamaDigest !== null;
  if (hasOllamaModel !== hasOllamaDigest) {
    protocolFail(`artifacts[${index}] must provide ollamaModel and ollamaDigest together`);
  }
  if (hasOllamaModel) {
    out.ollamaModel = requiredString(value.ollamaModel, `artifacts[${index}].ollamaModel`, 2048);
    out.ollamaDigest = sha256Value(value.ollamaDigest, `artifacts[${index}].ollamaDigest`);
  }
  if (value.metadata !== undefined) out.metadata = boundedClone(value.metadata, `artifacts[${index}].metadata`, 256 * 1024);
  return out;
}

async function responseError(response, prefix) {
  const text = await readBoundedText(response, MAX_ERROR_BYTES);
  let detail = text.trim();
  try {
    const parsed = detail ? JSON.parse(detail) : null;
    if (typeof parsed?.error === 'string') detail = parsed.error;
    else if (typeof parsed?.message === 'string') detail = parsed.message;
  } catch {
    // Plain-text error responses are allowed, but remain size-bounded.
  }
  return new TrainerProtocolError(`${prefix} (${response.status})${detail ? `: ${detail.slice(0, 2000)}` : ''}`, {
    status: response.status,
  });
}

async function readBoundedText(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        protocolFail(`Trainer response exceeds ${maxBytes} bytes`, { status: response.status });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size).toString('utf8');
}

function requestOptions(options) {
  return {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: options.signal,
    fetchImpl: options.fetchImpl ?? options.fetch,
    maxResponseBytes: options.maxResponseBytes,
  };
}

function boundedClone(value, label, maxBytes) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (cause) {
    protocolFail(`${label} must be JSON-compatible`, { cause });
  }
  if (encoded === undefined || Buffer.byteLength(encoded) > maxBytes) protocolFail(`${label} exceeds ${maxBytes} bytes`);
  try {
    return JSON.parse(encoded);
  } catch (cause) {
    protocolFail(`${label} must be valid JSON`, { cause });
  }
}

function sha256Value(value, label) {
  if (typeof value !== 'string') protocolFail(`${label} must be a SHA-256 string`);
  const normalized = value.toLowerCase().replace(/^sha256:/, '');
  if (!HEX_SHA256.test(normalized)) protocolFail(`${label} must contain 64 hexadecimal characters`);
  return normalized;
}

function jobId(value, label) {
  if (typeof value !== 'string' || !JOB_ID_PATTERN.test(value)) {
    protocolFail(`${label} must match ${JOB_ID_PATTERN}`);
  }
  return value;
}

function shortIdentifier(value, label) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9._-]{0,127}$/i.test(value)) {
    protocolFail(`${label} must be a short identifier`);
  }
  return value;
}

function requiredString(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    protocolFail(`${label} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function optionalString(value, max) {
  if (value === undefined || value === null || value === '') return '';
  return requiredString(value, 'value', max);
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) protocolFail(`${label} must be a non-negative integer`);
  return value;
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, ' ').slice(0, 1000);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function protocolFail(message, options) {
  throw new TrainerProtocolError(message, options);
}
