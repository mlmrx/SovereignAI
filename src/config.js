import fs from 'node:fs';
import path from 'node:path';
import { deepMerge, ssrfBlockedReason } from './util.js';

export const VERSION = '0.5.0';

// The SSRF guard lives in util.js (so safeFetch can reuse it without a
// circular import); re-exported here to keep the config.js import path stable.
export { ssrfBlockedReason } from './util.js';

const PROVIDER_IDS = ['ollama', 'freetoken', 'openai', 'anthropic'];
// Providers that carry no API key: local engines that answer on loopback
// without auth. They get no apiKey field at all, so nothing secret-shaped can
// ever be persisted for them.
const KEYLESS_PROVIDER_IDS = new Set(['ollama', 'freetoken']);
const TOP_LEVEL_KEYS = new Set([
  'name',
  'host',
  'port',
  'authToken',
  'providers',
  'defaults',
  'embeddings',
  'memory',
  'training',
  'limits',
  'trustedExtensionOrigins',
  'setupComplete',
]);

export const DEFAULT_CONFIG = {
  name: 'My Sovereign AI',
  host: '127.0.0.1',
  port: 4321,
  // When set, all API access requires "Authorization: Bearer <authToken>".
  authToken: null,
  providers: {
    ollama: { enabled: true, baseUrl: 'http://localhost:11434' },
    // Local MoE engine (github.com/FlashML-org/FreeToken): serves one open-weight model per process on loopback, no auth.
    freetoken: { enabled: false, baseUrl: 'http://127.0.0.1:1919' },
    // Works with any OpenAI-compatible server: vLLM, llama.cpp, LM Studio, Groq, Mistral, OpenAI…
    openai: { enabled: false, baseUrl: 'https://api.openai.com', apiKey: '' },
    anthropic: { enabled: false, apiKey: '', baseUrl: 'https://api.anthropic.com' },
  },
  defaults: { provider: 'ollama', model: '' },
  // Embeddings power semantic knowledge search. Falls back to keyword (BM25) search when unavailable.
  embeddings: { provider: 'ollama', model: 'nomic-embed-text' },
  // Auto memory: distill durable facts from conversations into long-term memory (extra model call per exchange).
  memory: { autoExtract: false, extractLocalOnly: false, extractionModel: '' },
  // Fine-tuning uses an optional user-operated HTTP trainer. Dataset content is
  // never sent there until a project snapshot is explicitly approved.
  training: {
    enabled: false,
    baseUrl: 'http://127.0.0.1:7331',
    authToken: '',
    allowRemote: false,
    allowInsecurePrivateNetwork: false,
  },
  limits: { historyChars: 24000, ragChunks: 6, maxTokens: 32000 },
  // Browser-extension origins (chrome-extension://<id> / moz-extension://<id>)
  // trusted to call the no-token localhost API. Empty by default: an installed
  // extension is not trusted just for existing — the operator pins its id here.
  trustedExtensionOrigins: [],
  // Flipped by the first-run wizard; false shows the guided setup in the web UI.
  setupComplete: false,
};

export function configPath(rootDir) {
  return path.join(rootDir, 'sovereign.config.json');
}

export function loadConfig(rootDir, { env = process.env } = {}) {
  let fileConfig = {};
  const file = configPath(rootDir);
  if (fs.existsSync(file)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new ConfigValidationError(`Invalid ${path.basename(file)}: ${err.message}`);
    }
  }
  const config = normalizeConfig(deepMerge(DEFAULT_CONFIG, fileConfig));
  applyEnvOverrides(config, env);
  return normalizeConfig(config);
}

/** Atomically write a normalized config file readable only by the current user. */
export function saveConfig(rootDir, config) {
  const normalized = normalizeConfig(config);
  const file = configPath(rootDir);
  const temp = path.join(rootDir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const data = JSON.stringify(normalized, null, 2) + '\n';
  fs.mkdirSync(rootDir, { recursive: true });
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, data, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch (err) {
      if (err.code !== 'EPERM' && err.code !== 'ENOSYS') throw err;
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  return normalized;
}

function applyEnvOverrides(config, env) {
  if (env.SOVEREIGN_HOST) config.host = env.SOVEREIGN_HOST;
  if (env.SOVEREIGN_PORT) config.port = Number(env.SOVEREIGN_PORT);
  if (env.SOVEREIGN_TOKEN) config.authToken = env.SOVEREIGN_TOKEN;
  if (env.OLLAMA_BASE_URL) config.providers.ollama.baseUrl = env.OLLAMA_BASE_URL;
  if (env.FREETOKEN_BASE_URL) {
    // Unlike OLLAMA_BASE_URL, this also enables the provider: FreeToken is off
    // by default, so a Docker/compose user who sets its URL clearly wants it on.
    config.providers.freetoken.baseUrl = env.FREETOKEN_BASE_URL;
    config.providers.freetoken.enabled = true;
  }
  if (env.OPENAI_BASE_URL) config.providers.openai.baseUrl = env.OPENAI_BASE_URL;
  if (env.OPENAI_API_KEY) {
    config.providers.openai.apiKey = env.OPENAI_API_KEY;
    config.providers.openai.enabled = true;
  }
  if (env.ANTHROPIC_API_KEY) {
    config.providers.anthropic.apiKey = env.ANTHROPIC_API_KEY;
    config.providers.anthropic.enabled = true;
  }
  if (env.SOVEREIGN_TRAINER_URL) {
    config.training.baseUrl = env.SOVEREIGN_TRAINER_URL;
    config.training.enabled = true;
  }
  if (env.SOVEREIGN_TRAINER_TOKEN) {
    config.training.authToken = env.SOVEREIGN_TRAINER_TOKEN;
    config.training.enabled = true;
  }
}

/** Copy of the config safe to send to the browser — API keys are masked. */
export function redactConfig(config) {
  const clone = structuredClone(config);
  for (const provider of Object.values(clone.providers)) {
    if (provider.apiKey) provider.apiKey = maskKey(provider.apiKey);
  }
  if (clone.training?.authToken) clone.training.authToken = maskKey(clone.training.authToken);
  if (clone.authToken) clone.authToken = maskKey(clone.authToken);
  return clone;
}

function maskKey(key) {
  return '••••••••';
}

/** Remove fields whose effective values are owned by process environment. */
export function withoutEnvironmentManagedFields(update, env = process.env) {
  const clean = structuredClone(update);
  if (!clean || typeof clean !== 'object' || Array.isArray(clean)) return clean;
  if (env.SOVEREIGN_HOST) delete clean.host;
  if (env.SOVEREIGN_PORT) delete clean.port;
  if (env.SOVEREIGN_TOKEN) delete clean.authToken;
  const provider = (id) => clean.providers && typeof clean.providers === 'object' && !Array.isArray(clean.providers)
    ? clean.providers[id]
    : null;
  if (env.OLLAMA_BASE_URL && provider('ollama') && typeof provider('ollama') === 'object') {
    delete provider('ollama').baseUrl;
  }
  if (env.FREETOKEN_BASE_URL && provider('freetoken') && typeof provider('freetoken') === 'object') {
    delete provider('freetoken').baseUrl;
    delete provider('freetoken').enabled;
  }
  if (env.OPENAI_BASE_URL && provider('openai') && typeof provider('openai') === 'object') {
    delete provider('openai').baseUrl;
  }
  if (env.OPENAI_API_KEY && provider('openai') && typeof provider('openai') === 'object') {
    delete provider('openai').apiKey;
    delete provider('openai').enabled;
  }
  if (env.ANTHROPIC_API_KEY && provider('anthropic') && typeof provider('anthropic') === 'object') {
    delete provider('anthropic').apiKey;
    delete provider('anthropic').enabled;
  }
  if (env.SOVEREIGN_TRAINER_URL && clean.training && typeof clean.training === 'object') {
    delete clean.training.baseUrl;
    delete clean.training.enabled;
  }
  if (env.SOVEREIGN_TRAINER_TOKEN && clean.training && typeof clean.training === 'object') {
    delete clean.training.authToken;
    delete clean.training.enabled;
  }
  return clean;
}

/** Remove secrets previously materialized from the currently active env. */
export function scrubPersistedEnvironmentSecrets(config, env = process.env) {
  const clean = structuredClone(config);
  if (env.SOVEREIGN_TOKEN && clean.authToken === env.SOVEREIGN_TOKEN) clean.authToken = null;
  if (env.OPENAI_API_KEY && clean.providers?.openai?.apiKey === env.OPENAI_API_KEY) {
    clean.providers.openai.apiKey = '';
  }
  if (env.ANTHROPIC_API_KEY && clean.providers?.anthropic?.apiKey === env.ANTHROPIC_API_KEY) {
    clean.providers.anthropic.apiKey = '';
  }
  if (env.SOVEREIGN_TRAINER_TOKEN && clean.training?.authToken === env.SOVEREIGN_TRAINER_TOKEN) {
    clean.training.authToken = '';
  }
  return clean;
}

/** Merge and validate a partial config update from the UI. */
export function mergeConfigUpdate(current, update) {
  assertPlainObject(update, 'config update');
  assertKnownKeys(update, TOP_LEVEL_KEYS, 'config update');
  const safeUpdate = structuredClone(update);
  if (safeUpdate.providers !== undefined) {
    assertPlainObject(safeUpdate.providers, 'providers');
    assertKnownKeys(safeUpdate.providers, new Set(PROVIDER_IDS), 'providers');
    for (const [id, provider] of Object.entries(safeUpdate.providers)) {
      assertPlainObject(provider, `providers.${id}`);
      if (typeof provider.apiKey === 'string' && provider.apiKey.includes('••')) {
        provider.apiKey = current.providers?.[id]?.apiKey ?? '';
      }
    }
  }
  if (typeof safeUpdate.authToken === 'string' && safeUpdate.authToken.includes('••')) {
    safeUpdate.authToken = current.authToken;
  }
  if (safeUpdate.training !== undefined) {
    assertPlainObject(safeUpdate.training, 'training');
    if (typeof safeUpdate.training.authToken === 'string' && safeUpdate.training.authToken.includes('••')) {
      safeUpdate.training.authToken = current.training?.authToken ?? '';
    }
  }
  try {
    return normalizeConfig(deepMerge(current, safeUpdate));
  } catch (err) {
    if (err instanceof TypeError && err.message.startsWith('Unsafe object key:')) fail(err.message);
    throw err;
  }
}

export class ConfigValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

export function normalizeConfig(value) {
  assertPlainObject(value, 'config');
  assertKnownKeys(value, TOP_LEVEL_KEYS, 'config');
  return {
    name: stringValue(value.name, 'name', { min: 1, max: 200, trim: true }),
    host: stringValue(value.host, 'host', { min: 1, max: 255, trim: true }),
    port: integerValue(value.port, 'port', 1, 65535),
    authToken: nullableSecret(value.authToken, 'authToken'),
    providers: normalizeProviders(value.providers),
    defaults: normalizeDefaults(value.defaults),
    embeddings: normalizeEmbeddings(value.embeddings),
    memory: normalizeMemory(value.memory),
    training: normalizeTraining(value.training),
    limits: normalizeLimits(value.limits),
    trustedExtensionOrigins: normalizeTrustedExtensionOrigins(value.trustedExtensionOrigins),
    setupComplete: booleanValue(value.setupComplete, 'setupComplete'),
  };
}

function normalizeTrustedExtensionOrigins(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('trustedExtensionOrigins must be an array of extension origins');
  if (value.length > 32) fail('trustedExtensionOrigins allows at most 32 entries');
  return value.map((entry, index) => {
    const origin = stringValue(entry, `trustedExtensionOrigins[${index}]`, { min: 1, max: 2048, trim: true });
    if (!/^(chrome-extension|moz-extension):\/\/[a-z0-9-]+\/?$/i.test(origin)) {
      fail(`trustedExtensionOrigins[${index}] must be a chrome-extension:// or moz-extension:// origin`);
    }
    return origin.replace(/\/$/, '');
  });
}

function normalizeProviders(value) {
  assertPlainObject(value, 'providers');
  assertKnownKeys(value, new Set(PROVIDER_IDS), 'providers');
  const out = {};
  for (const id of PROVIDER_IDS) {
    const provider = value[id];
    assertPlainObject(provider, `providers.${id}`);
    const keyless = KEYLESS_PROVIDER_IDS.has(id);
    const allowed = keyless ? new Set(['enabled', 'baseUrl']) : new Set(['enabled', 'baseUrl', 'apiKey']);
    assertKnownKeys(provider, allowed, `providers.${id}`);
    out[id] = {
      enabled: booleanValue(provider.enabled, `providers.${id}.enabled`),
      baseUrl: urlValue(provider.baseUrl, `providers.${id}.baseUrl`),
    };
    if (!keyless) out[id].apiKey = secretValue(provider.apiKey, `providers.${id}.apiKey`, true);
  }
  return out;
}

function normalizeDefaults(value) {
  assertPlainObject(value, 'defaults');
  assertKnownKeys(value, new Set(['provider', 'model', 'personaId']), 'defaults');
  const out = {
    provider: providerId(value.provider, 'defaults.provider'),
    model: stringValue(value.model, 'defaults.model', { min: 0, max: 500, trim: true }),
  };
  if (value.personaId !== undefined) {
    out.personaId = value.personaId === null
      ? null
      : stringValue(value.personaId, 'defaults.personaId', { min: 1, max: 200, trim: true });
  }
  return out;
}

function normalizeEmbeddings(value) {
  assertPlainObject(value, 'embeddings');
  assertKnownKeys(value, new Set(['provider', 'model']), 'embeddings');
  return {
    provider: providerId(value.provider, 'embeddings.provider'),
    model: stringValue(value.model, 'embeddings.model', { min: 0, max: 500, trim: true }),
  };
}

function normalizeMemory(value) {
  assertPlainObject(value, 'memory');
  assertKnownKeys(value, new Set(['autoExtract', 'extractLocalOnly', 'extractionModel']), 'memory');
  const extractionModel = value.extractionModel === undefined ? '' : String(value.extractionModel).trim();
  if (extractionModel.length > 2048) fail('memory.extractionModel must be at most 2048 characters');
  if (/[\r\n\0]/.test(extractionModel)) fail('memory.extractionModel must be a single-line model name');
  return {
    autoExtract: booleanValue(value.autoExtract, 'memory.autoExtract'),
    // Cognition stays home: when true, the model calls that WRITE long-term
    // memory (auto-extract, distillation) are refused unless the provider
    // endpoint is local — even when chat itself uses a remote provider.
    extractLocalOnly: booleanValue(value.extractLocalOnly, 'memory.extractLocalOnly'),
    // The cognition role: when set, memory-writing calls always run on the
    // default provider with THIS model — a small local model can own what
    // gets learned about you while chat uses anything.
    extractionModel,
  };
}

function normalizeTraining(value) {
  assertPlainObject(value, 'training');
  assertKnownKeys(value, new Set(['enabled', 'baseUrl', 'authToken', 'allowRemote', 'allowInsecurePrivateNetwork']), 'training');
  const training = {
    enabled: booleanValue(value.enabled, 'training.enabled'),
    baseUrl: urlValue(value.baseUrl, 'training.baseUrl'),
    authToken: secretValue(value.authToken, 'training.authToken', true),
    allowRemote: booleanValue(value.allowRemote, 'training.allowRemote'),
    allowInsecurePrivateNetwork: booleanValue(value.allowInsecurePrivateNetwork, 'training.allowInsecurePrivateNetwork'),
  };
  let url;
  try { url = new URL(training.baseUrl); } catch { return training; }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (!loopback && !training.allowRemote) fail('training.allowRemote must be enabled for a non-loopback trainer');
  if (!loopback && url.protocol !== 'https:' && !training.allowInsecurePrivateNetwork) {
    fail('training.allowInsecurePrivateNetwork must be enabled for a non-loopback HTTP trainer');
  }
  return training;
}

function normalizeLimits(value) {
  assertPlainObject(value, 'limits');
  assertKnownKeys(value, new Set(['historyChars', 'ragChunks', 'maxTokens']), 'limits');
  return {
    historyChars: integerValue(value.historyChars, 'limits.historyChars', 1, 2_000_000),
    ragChunks: integerValue(value.ragChunks, 'limits.ragChunks', 1, 100),
    maxTokens: integerValue(value.maxTokens, 'limits.maxTokens', 1, 262_144),
  };
}

function providerId(value, label) {
  const id = stringValue(value, label, { min: 1, max: 100, trim: true });
  if (!PROVIDER_IDS.includes(id)) fail(`${label} must be one of: ${PROVIDER_IDS.join(', ')}`);
  return id;
}

function urlValue(value, label) {
  const raw = stringValue(value, label, { min: 1, max: 2048, trim: true });
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail(`${label} must be a valid HTTP(S) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail(`${label} must use http or https`);
  if (parsed.username || parsed.password) fail(`${label} must not contain credentials; use the API-key field`);
  if (parsed.search || parsed.hash) fail(`${label} must not contain a query string or fragment`);
  const blocked = ssrfBlockedReason(parsed.hostname);
  if (blocked) fail(`${label} may not point at ${blocked}`);
  return raw.replace(/\/+$/, '');
}


function nullableSecret(value, label) {
  if (value === null || value === '') return null;
  return secretValue(value, label, false);
}

function secretValue(value, label, allowEmpty) {
  return stringValue(value, label, { min: allowEmpty ? 0 : 1, max: 8192, trim: false });
}

function stringValue(value, label, { min, max, trim }) {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  const normalized = trim ? value.trim() : value;
  if (normalized.length < min || normalized.length > max) fail(`${label} must be ${min}-${max} characters`);
  return normalized;
}

function integerValue(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) fail(`${label} must be an integer from ${min} to ${max}`);
  return value;
}

function booleanValue(value, label) {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`);
  return value;
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
}

function assertKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} contains unknown field "${key}"`);
  }
}

function fail(message) {
  throw new ConfigValidationError(message);
}
