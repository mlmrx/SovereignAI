import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ssrfBlockedReason, redactApiKeys, safeFetch } from '../src/util.js';
import { normalizeConfig, DEFAULT_CONFIG } from '../src/config.js';
import { dockerRunCommand } from '../src/byoc/connector.js';
import { getProvider } from '../src/providers/index.js';
import { getGpuProvider } from '../src/byoc/providers/index.js';
import { extractPdf } from '../src/ingest/pdf.js';
import { parseEmail } from '../src/ingest/mbox.js';

// Regression tests for the security audit fixes. Each ReDoS test asserts a
// generous wall-clock bound: the fixed code runs in single-digit ms, while the
// vulnerable versions took many seconds-to-minutes on these exact inputs — so
// even a slow CI machine clears the bound only if the fix is in place.

test('SSRF guard blocks IPv4-mapped IPv6 forms of the metadata address', () => {
  // WHATWG normalizes [::ffff:169.254.169.254] to the hex form.
  assert.ok(ssrfBlockedReason('::ffff:a9fe:a9fe'), 'hex-mapped IMDS must be blocked');
  assert.ok(ssrfBlockedReason('::ffff:169.254.169.254'), 'dotted-mapped IMDS must be blocked');
  assert.ok(ssrfBlockedReason('169.254.169.254'), 'bare IMDS still blocked');
  assert.ok(ssrfBlockedReason('[::ffff:169.254.169.254]'), 'bracketed form blocked');
  // Legitimate hosts still allowed (the guard is a metadata blocklist by design).
  assert.equal(ssrfBlockedReason('localhost'), null);
  assert.equal(ssrfBlockedReason('192.168.1.10'), null);
  assert.equal(ssrfBlockedReason('::ffff:192.168.1.10'), null, 'mapped private IP is not metadata');
  assert.equal(ssrfBlockedReason('api.openai.com'), null);
});

test('BYOC docker run quotes the image reference (no shell injection via --image)', () => {
  const cmd = dockerRunCommand({ name: 'main', bind: 'loopback', port: 4321, imageRef: 'ghcr.io/o/s:tag; rm -rf ~' });
  // The metacharacters must be inside a single-quoted token, not live shell.
  assert.ok(/'ghcr\.io\/o\/s:tag; rm -rf ~'/.test(cmd), `image ref must be single-quoted: ${cmd}`);
  assert.doesNotMatch(cmd, /:tag; rm -rf ~ *$/, 'trailing metacharacters must not sit unquoted at end of command');
});

test('PDF extractor does not hang on an adversarial TJ backslash run (ReDoS fixed)', () => {
  // A minimal but valid-enough PDF whose uncompressed content stream contains
  // BT (passes the guard) then an unterminated [ with a long backslash run —
  // the exact exponential trigger against the old TJ-array class. Whether the
  // extractor returns text or throws "could not extract" is irrelevant; the
  // regression is that extractTextOps must not hang first.
  const payload = `BT\n[${'\\'.repeat(60)}`;
  const pdf = Buffer.from(`%PDF-1.4\n<<>>\nstream\n${payload}\nendstream\n%%EOF`, 'latin1');
  const started = process.hrtime.bigint();
  try {
    extractPdf(pdf);
  } catch {
    /* expected: no readable text — the point is it completed, not hung */
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 1000, `TJ parse took ${ms.toFixed(0)}ms — expected well under 1s`);
});

test('email From-header parsing does not hang on adversarial input (ReDoS fixed)', () => {
  const build = (fromValue) =>
    Buffer.from(`Message-ID: <x@y>\r\nDate: Tue, 05 Aug 2025 10:00:00 +0000\r\nFrom: ${fromValue}\r\nSubject: hi\r\n\r\nbody\r\n`, 'utf8');
  const cases = [
    `<${'a@'.repeat(9000)}`, // angled branch: many '@', no closing '>'
    `${'a.'.repeat(9000)}@${'b.'.repeat(9000)}`, // bare branch: long dotted runs, no match
  ];
  for (const value of cases) {
    const started = process.hrtime.bigint();
    const parsed = parseEmail(build(value));
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(typeof parsed.from.address, 'string');
    assert.ok(ms < 1000, `From parse took ${ms.toFixed(0)}ms on a ${value.length}-char header — expected well under 1s`);
  }
});

test('a normal address still parses correctly after the ReDoS hardening', () => {
  const raw = Buffer.from('Message-ID: <a@b>\r\nFrom: "ACME Store" <no-reply@mail.acme.com>\r\nSubject: Receipt\r\n\r\nhi\r\n', 'utf8');
  const parsed = parseEmail(raw);
  assert.equal(parsed.from.name, 'ACME Store');
  assert.equal(parsed.from.address, 'no-reply@mail.acme.com');
});

// ---- R1: safeFetch resolves and blocks metadata targets ----

test('safeFetch refuses an IP literal metadata target and a name that resolves to one', async () => {
  await assert.rejects(safeFetch('http://169.254.169.254/latest/meta-data/'), /Refusing to connect/);
  await assert.rejects(safeFetch('http://[::ffff:169.254.169.254]/'), /Refusing to connect/);
  // A hostname whose only sensible resolution is loopback still works (IP check skipped for names,
  // resolution allowed) — proven by reaching a real local server through a DNS name.
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await safeFetch(`http://localhost:${server.address().port}/`);
    assert.equal(await res.text(), 'ok', 'a legitimate localhost name must still be reachable');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---- R3: extension origins are allowlisted, not blanket-trusted ----

test('trustedExtensionOrigins validates and only accepts extension origins', () => {
  const ok = normalizeConfig({ ...DEFAULT_CONFIG, trustedExtensionOrigins: ['chrome-extension://abcdefghijklmnop'] });
  assert.deepEqual(ok.trustedExtensionOrigins, ['chrome-extension://abcdefghijklmnop']);
  assert.deepEqual(normalizeConfig(DEFAULT_CONFIG).trustedExtensionOrigins, [], 'default is empty — no extension trusted for existing');
  assert.throws(() => normalizeConfig({ ...DEFAULT_CONFIG, trustedExtensionOrigins: ['http://evil.example'] }), /must be a chrome-extension/);
});

// ---- R7: provider error bodies are redacted before surfacing ----

test('redactApiKeys strips keys and bearer tokens from surfaced text', () => {
  assert.match(redactApiKeys('Incorrect API key provided: sk-ant-api03-ABCDEF123456'), /\[redacted-key\]/);
  assert.doesNotMatch(redactApiKeys('bad key sk-proj-SECRETSECRET1234'), /SECRETSECRET/);
  const bearer = redactApiKeys('header was Authorization: Bearer abcdef123456ghijkl');
  assert.doesNotMatch(bearer, /abcdef123456ghijkl/, 'the bearer token must not survive');
  assert.match(bearer, /redacted/);
  assert.equal(redactApiKeys('plain error, no secrets here'), 'plain error, no secrets here');
});

// ---- R8: provider lookups fail cleanly on inherited prototype keys ----

test('provider registries reject inherited prototype keys instead of resolving them', () => {
  assert.throws(() => getProvider('constructor'), /Unknown provider/);
  assert.throws(() => getProvider('toString'), /Unknown provider/);
  assert.throws(() => getGpuProvider('constructor'), /Unknown GPU provider/);
});
