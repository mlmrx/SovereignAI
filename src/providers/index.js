import { ollama } from './ollama.js';
import { freetoken, isFreeTokenHealth, readFreeTokenHealth } from './freetoken.js';
import { openai } from './openai.js';
import { anthropic } from './anthropic.js';
import { safeFetch } from '../util.js';

// Local engines first: this order drives the /api/providers rows and the status
// pills in the UI (the doctor prints its provider lines in completion order).
export const providers = { ollama, freetoken, openai, anthropic };

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

/**
 * The host a provider's requests go to — hostname plus an explicit port,
 * never the path and never credentials — for the outgoing preview and the
 * receipt on a remote answer (ADR-26). Null when no endpoint is configured.
 */
export function providerEndpointHost(cfg) {
  try {
    return new URL(cfg?.baseUrl ?? '').host || null;
  } catch {
    return null;
  }
}

/**
 * Is a FreeToken engine running on THIS machine, whether or not anyone has
 * enabled the provider? `providerStatus` cannot answer that: a disabled
 * provider is not "configured", so it is never health-checked, and a person
 * who started `ft serve` before opening SovereignAI would see no sign of it.
 * The first-run wizard and `sovereign doctor` both need the answer, so it
 * lives here rather than twice.
 *
 * Only loopback is ever contacted. A disabled provider pointed at a LAN or
 * remote host is left alone: detection is a courtesy for the engine on this
 * machine, never a reason to send an unsolicited request to someone else's.
 *
 * Returns null when nothing FreeToken-shaped answers — including when
 * something else is listening on the port. When one does answer, the verdict
 * is read by the provider's own health parser, so the wizard, the Settings
 * card, and the doctor describe one engine in one vocabulary.
 */
export async function detectLocalFreeToken(cfg, { timeoutMs = 1500 } = {}) {
  const baseUrl = String(cfg?.baseUrl ?? '').replace(/\/+$/, '');
  if (!baseUrl || !isLocalProviderEndpoint('freetoken', { baseUrl })) return null;
  let body;
  try {
    const res = await safeFetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    body = await res.json();
  } catch {
    return null;
  }
  if (!isFreeTokenHealth(body)) return null;
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim().slice(0, 240) : null;
  try {
    const health = readFreeTokenHealth(body);
    return { url: baseUrl, model, ready: true, detail: health.detail };
  } catch (err) {
    // Running, but not ready: loading, rebuilding, or errored. The reason is
    // worth showing — "still loading, 42%" is a wait, not a failure.
    return { url: baseUrl, model, ready: false, detail: err.message };
  }
}

/** Status summary for all providers (configured + reachable + local). */
export async function providerStatus(config) {
  const results = [];
  for (const provider of Object.values(providers)) {
    const cfg = config.providers[provider.id];
    const entry = {
      id: provider.id,
      label: provider.label,
      enabled: Boolean(cfg?.enabled),
      configured: provider.isConfigured(cfg ?? {}),
      // Whether a send to this provider stays on this machine — the same rule
      // the outgoing preview gates on, so the UI never has to guess.
      local: isLocalProviderEndpoint(provider.id, cfg ?? {}),
    };
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
