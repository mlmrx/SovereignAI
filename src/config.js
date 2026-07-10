import fs from 'node:fs';
import path from 'node:path';
import { deepMerge } from './util.js';

export const VERSION = '0.3.0';

const PROVIDER_IDS = ['ollama', 'openai', 'anthropic'];
const TOP_LEVEL_KEYS = new Set([
  'name',
  'host',
  'port',
  'authToken',
  'providers',
  'defaults',
  'embeddings',
  'memory',
  'limits',
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
    // Works with any OpenAI-compatible server: vLLM, llama.cpp, LM Studio, Groq, Mistral, OpenAI…
    openai: { enabled: false, baseUrl: 'https://api.openai.com', apiKey: '' },
    anthropic: { enabled: false, apiKey: '', baseUrl: 'https://api.anthropic.com' },
  },
  defaults: { provider: 'ollama', model: '' },
  // Embeddings power semantic knowledge search. Falls back to keyword (BM25) search when unavailable.
  embeddings: { provider: 'ollama', model: 'nomic-embed-text' },
  // Auto memory: distill durable facts from conversations into long-term memory (extra model call per exchange).
  memory: { autoExtract: false },
  limits: { historyChars: 24000, ragChunks: 6, maxTokens: 32000 },
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
  if (env.OPENAI_BASE_URL) config.providers.openai.baseUrl = env.OPENAI_BASE_URL;
  if (env.OPENAI_API_KEY) {
    config.providers.openai.apiKey = env.OPENAI_API_KEY;
    config.providers.openai.enabled = true;
  }
  if (env.ANTHROPIC_API_KEY) {
    config.providers.anthropic.apiKey = env.ANTHROPIC_API_KEY;
    config.providers.anthropic.enabled = true;
  }
}

/** Copy of the config safe to send to the browser — API keys are masked. */
export function redactConfig(config) {
  const clone = structuredClone(config);
  for (const provider of Object.values(clone.providers)) {
    if (provider.apiKey) provider.apiKey = maskKey(provider.apiKey);
  }
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
    limits: normalizeLimits(value.limits),
    setupComplete: booleanValue(value.setupComplete, 'setupComplete'),
  };
}

function normalizeProviders(value) {
  assertPlainObject(value, 'providers');
  assertKnownKeys(value, new Set(PROVIDER_IDS), 'providers');
  const out = {};
  for (const id of PROVIDER_IDS) {
    const provider = value[id];
    assertPlainObject(provider, `providers.${id}`);
    const allowed = id === 'ollama' ? new Set(['enabled', 'baseUrl']) : new Set(['enabled', 'baseUrl', 'apiKey']);
    assertKnownKeys(provider, allowed, `providers.${id}`);
    out[id] = {
      enabled: booleanValue(provider.enabled, `providers.${id}.enabled`),
      baseUrl: urlValue(provider.baseUrl, `providers.${id}.baseUrl`),
    };
    if (id !== 'ollama') out[id].apiKey = secretValue(provider.apiKey, `providers.${id}.apiKey`, true);
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
  assertKnownKeys(value, new Set(['autoExtract']), 'memory');
  return { autoExtract: booleanValue(value.autoExtract, 'memory.autoExtract') };
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
