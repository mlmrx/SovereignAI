import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';

export const CHAT_TIMEOUT_MS = 5 * 60 * 1000;

// SSRF guard for user-supplied outbound URLs (provider/trainer endpoints the
// server fetches). Cloud metadata and link-local addresses are always blocked
// — they are never a legitimate model endpoint and are the classic pivot for
// stealing instance credentials. Loopback and normal LAN/private hosts remain
// allowed: a local or on-LAN Ollama box is the common, intended case. Returns
// a human reason string when blocked, or null when allowed. Lives here (not in
// config.js) so safeFetch can reuse it without a circular import.
export function ssrfBlockedReason(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');

  // IMDS hostnames some clouds resolve by name, plus the canonical metadata IPs.
  if (host === 'metadata.google.internal' || host === 'metadata') return 'a cloud metadata endpoint';

  // Resolve an IPv4-mapped IPv6 address to its embedded IPv4 first, so the
  // link-local check below cannot be bypassed by writing the metadata IP as
  // [::ffff:169.254.169.254] — which WHATWG normalizes to ::ffff:a9fe:a9fe.
  const embedded = embeddedMappedIpv4(host);
  const v4 = (embedded || host).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((n) => n > 255)) return null; // not a real IPv4 literal; leave to DNS
    const [a, b] = octets;
    // 169.254.0.0/16 — link-local, which is where 169.254.169.254 (IMDS) lives.
    if (a === 169 && b === 254) return 'a link-local / cloud metadata address';
  }

  // IPv6 link-local (fe80::/10) and the metadata mapping fd00:ec2::254.
  if (host.startsWith('fe80:') || host.startsWith('fe80::') || host === 'fd00:ec2::254') {
    return 'a link-local / cloud metadata address';
  }
  return null;
}

// Extract the embedded IPv4 from an ::ffff:… IPv4-mapped IPv6 host, in either
// the dotted (::ffff:169.254.169.254) or hex (::ffff:a9fe:a9fe) form WHATWG may
// produce. Returns a dotted-quad string, or null if not a mapped address.
function embeddedMappedIpv4(host) {
  const dotted = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (dotted) return dotted[1];
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return null;
}

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
 * fetch() for user-configured outbound endpoints (model providers). Two SSRF
 * defenses config-time validation cannot provide alone:
 *  - `redirect: 'error'` — a validated baseUrl returning a 3xx to
 *    http://169.254.169.254/ would otherwise bypass the check (and re-send the
 *    provider's auth header to the redirect target). The redirect throws.
 *  - resolve-and-check — the config-time guard only inspects the literal
 *    hostname, so a name whose A-record points at the metadata IP passes it.
 *    Here we resolve the host and refuse if ANY resolved address is a blocked
 *    metadata/link-local target. (Residual: a live attacker racing DNS between
 *    this lookup and fetch's own resolution — out of scope for the
 *    tricked-operator-config threat model this guards.)
 */
export async function safeFetch(url, options = {}) {
  let host = null;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    /* non-URL input (unusual) — fall through to fetch, which will reject it */
  }
  if (host) {
    if (net.isIP(host)) {
      const blocked = ssrfBlockedReason(host);
      if (blocked) throw new Error(`Refusing to connect to ${blocked}`);
    } else {
      let addresses = [];
      try {
        addresses = await dns.lookup(host, { all: true });
      } catch {
        /* unresolvable — let fetch fail naturally; it cannot reach anything */
      }
      for (const { address } of addresses) {
        const blocked = ssrfBlockedReason(address);
        if (blocked) throw new Error(`Refusing to connect: ${host} resolves to ${blocked}`);
      }
    }
  }
  return fetch(url, { ...options, redirect: 'error' });
}

// Strip anything that looks like an API key or bearer token from text that
// will be surfaced to a client. Provider error bodies (e.g. an OpenAI 401)
// can echo a partial or full key; a misconfigured OpenAI-compatible endpoint
// might reflect the Authorization header. Pattern-based, since the surfacing
// path doesn't have the configured secret in hand.
export function redactApiKeys(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\b(sk|rk|pk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{6,}\b/g, '[redacted-key]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{6,}=*/gi, 'Bearer [redacted]')
    .replace(/\b(api[_-]?key|authorization|x-api-key)("?\s*[:=]\s*"?)[^\s",}]{6,}/gi, '$1$2[redacted]');
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
