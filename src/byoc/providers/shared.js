import { safeFetch } from '../../util.js';

// Shared plumbing for GPU marketplace clients (runpod.js, vastai.js,
// lambda.js). Each client is a best-effort implementation of a public API
// contract we cannot exercise live in this repository — see the prominent
// warning at the top of each provider file before trusting these against a
// real account.

export class GpuProviderError extends Error {
  constructor(message, { status = 502 } = {}) {
    super(message);
    this.name = 'GpuProviderError';
    this.status = status;
  }
}

export function requireApiKey(apiKey, providerLabel) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new GpuProviderError(`${providerLabel} API key is required`, { status: 400 });
  }
  return apiKey.trim();
}

const REQUEST_TIMEOUT_MS = 20_000;

/** POST/GET/PUT/DELETE + JSON in, JSON out, with a provider-labeled error on any failure mode. */
export async function fetchJson(url, { method = 'GET', headers = {}, body, providerLabel } = {}) {
  let res;
  try {
    res = await safeFetch(url, {
      method,
      headers: {
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GpuProviderError(`Could not reach ${providerLabel}: ${err.message}`, { status: 502 });
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new GpuProviderError(`${providerLabel} returned a response that was not valid JSON`, { status: 502 });
    }
  }
  if (!res.ok) {
    const detail = extractErrorDetail(data) ?? `HTTP ${res.status}`;
    const status = res.status === 401 || res.status === 403 ? res.status : 502;
    throw new GpuProviderError(`${providerLabel} error: ${detail}`, { status });
  }
  return data;
}

function extractErrorDetail(data) {
  if (!data || typeof data !== 'object') return null;
  if (typeof data.error === 'string') return data.error;
  if (data.error && typeof data.error.message === 'string') return data.error.message;
  if (Array.isArray(data.errors) && typeof data.errors[0]?.message === 'string') return data.errors[0].message;
  if (typeof data.message === 'string') return data.message;
  return null;
}

/** Instance/pod display name: providers vary in what they accept, so keep it boring. */
export function instanceLabel(name) {
  return `sovereignai-${String(name).slice(0, 40)}`;
}
