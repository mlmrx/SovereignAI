import crypto from 'node:crypto';

export const CHAT_TIMEOUT_MS = 5 * 60 * 1000;

export function newId() {
  return crypto.randomUUID();
}

export function now() {
  return new Date().toISOString();
}

/** Read and parse a JSON request body (with a size cap). */
export function readJsonBody(req, { maxBytes = 20 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * fetch() for user-configured outbound endpoints (model providers). Refuses to
 * follow redirects: a provider baseUrl is validated against SSRF targets at
 * config time, but a 3xx to http://169.254.169.254/ would bypass that check.
 * `redirect: 'error'` makes the redirect itself throw instead of chasing it.
 */
export function safeFetch(url, options = {}) {
  return fetch(url, { ...options, redirect: 'error' });
}

export function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** Apply browser-facing hardening headers before any response is written. */
export function applySecurityHeaders(res, { hsts = false } = {}) {
  res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader('cross-origin-resource-policy', 'same-origin');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  // HSTS is opt-in: it must only be sent when the origin is genuinely served
  // over HTTPS (a TLS-terminating proxy in front of SovereignAI). Emitting it
  // on the default plain-HTTP local install would wrongly force https and lock
  // users out. Cloud/BYOC deploys behind TLS set SOVEREIGN_HTTPS=1.
  if (hsts) res.setHeader('strict-transport-security', 'max-age=63072000; includeSubDomains');
}

export function isJsonRequest(req) {
  const type = req.headers['content-type'];
  return typeof type === 'string' && type.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

/** Combine caller cancellation with a hard deadline for provider streams. */
export function withTimeoutSignal(signal, timeoutMs = CHAT_TIMEOUT_MS) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Server-Sent Events helper bound to a response. */
export function sseStart(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(':ok\n\n');
  return {
    send(event, data) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() {
      res.end();
    },
  };
}

/** Cosine similarity between two equal-length vectors. */
export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Deep-merge plain objects; arrays and scalars are replaced, not merged. */
export function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override ?? base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new TypeError(`Unsafe object key: ${key}`);
    }
    out[key] = isPlainObject(base[key]) && isPlainObject(value) ? deepMerge(base[key], value) : value;
  }
  return out;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
