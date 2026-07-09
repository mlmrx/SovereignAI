import fs from 'node:fs';
import path from 'node:path';
import { deepMerge } from './util.js';

export const VERSION = '0.1.0';

export const DEFAULT_CONFIG = {
  name: 'My Sovereign AI',
  host: '127.0.0.1',
  port: 4321,
  // When set, non-localhost API access requires "Authorization: Bearer <authToken>".
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
  limits: { historyChars: 24000, ragChunks: 6, maxTokens: 32000 },
};

export function configPath(rootDir) {
  return path.join(rootDir, 'sovereign.config.json');
}

export function loadConfig(rootDir) {
  let fileConfig = {};
  const file = configPath(rootDir);
  if (fs.existsSync(file)) {
    fileConfig = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const config = deepMerge(DEFAULT_CONFIG, fileConfig);
  applyEnvOverrides(config);
  return config;
}

export function saveConfig(rootDir, config) {
  fs.writeFileSync(configPath(rootDir), JSON.stringify(config, null, 2) + '\n');
}

function applyEnvOverrides(config) {
  const env = process.env;
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
  if (key.length <= 8) return '••••';
  return key.slice(0, 4) + '••••' + key.slice(-4);
}

/**
 * Merge a config update coming from the UI. Masked secrets ("••" placeholders)
 * mean "keep the existing value".
 */
export function mergeConfigUpdate(current, update) {
  const merged = deepMerge(current, update);
  for (const [id, provider] of Object.entries(merged.providers ?? {})) {
    if (typeof provider.apiKey === 'string' && provider.apiKey.includes('••')) {
      provider.apiKey = current.providers?.[id]?.apiKey ?? '';
    }
  }
  if (typeof merged.authToken === 'string' && merged.authToken.includes('••')) {
    merged.authToken = current.authToken;
  }
  return merged;
}
