import { ollama } from './ollama.js';
import { openai } from './openai.js';
import { anthropic } from './anthropic.js';

export const providers = { ollama, openai, anthropic };

export function getProvider(id) {
  // Object.hasOwn, not a truthy lookup, so 'constructor'/'__proto__' can't
  // resolve to an inherited value instead of failing cleanly.
  if (typeof id !== 'string' || !Object.hasOwn(providers, id)) throw new Error(`Unknown provider: ${id}`);
  return providers[id];
}

/**
 * Whether a provider's endpoint stays on this machine (or this Compose
 * stack). Anthropic is remote by definition. For endpoint providers the
 * host list mirrors what the UI badges as "Local" — loopback plus the
 * Docker-internal names our own compose file uses.
 */
export function isLocalProviderEndpoint(providerId, cfg) {
  if (providerId === 'anthropic') return false;
  try {
    const host = new URL(cfg?.baseUrl ?? '').hostname.toLowerCase().replace(/\.$/, '');
    return (
      ['localhost', '::1', '[::1]', '0.0.0.0', 'host.docker.internal', 'ollama'].includes(host) || host.startsWith('127.')
    );
  } catch {
    return false;
  }
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
