import { ollama } from './ollama.js';
import { openai } from './openai.js';
import { anthropic } from './anthropic.js';

export const providers = { ollama, openai, anthropic };

export function getProvider(id) {
  const provider = providers[id];
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  return provider;
}

/** Status summary for all providers (configured + reachable). */
export async function providerStatus(config) {
  const results = [];
  for (const provider of Object.values(providers)) {
    const cfg = config.providers[provider.id];
    const entry = { id: provider.id, label: provider.label, enabled: Boolean(cfg?.enabled), configured: provider.isConfigured(cfg ?? {}) };
    if (entry.configured) {
      try {
        const health = await provider.health(cfg);
        entry.ok = health.ok;
        entry.detail = health.detail;
      } catch (err) {
        entry.ok = false;
        entry.detail = err.message;
      }
    }
    results.push(entry);
  }
  return results;
}
