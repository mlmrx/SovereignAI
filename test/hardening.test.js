import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigValidationError, mergeConfigUpdate, ssrfBlockedReason, DEFAULT_CONFIG } from '../src/config.js';
import { safeFetch, applySecurityHeaders } from '../src/util.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(repo, file), 'utf8');

test('SSRF guard blocks cloud metadata and link-local, allows real endpoints', () => {
  // blocked — the classic credential-theft pivots
  for (const host of ['169.254.169.254', '169.254.0.1', 'metadata.google.internal', 'metadata', 'fe80::1', 'fd00:ec2::254']) {
    assert.ok(ssrfBlockedReason(host), `must block ${host}`);
  }
  // allowed — the legitimate, common cases (local + on-LAN model servers, real hosts)
  for (const host of ['localhost', '127.0.0.1', '::1', '192.168.1.10', '10.0.0.5', 'ollama', 'api.openai.com', 'api.anthropic.com', '169.253.1.1']) {
    assert.equal(ssrfBlockedReason(host), null, `must allow ${host}`);
  }
});

test('provider baseUrl rejects SSRF targets at config time', () => {
  const current = structuredClone(DEFAULT_CONFIG);
  assert.throws(
    () => mergeConfigUpdate(current, { providers: { ollama: { enabled: true, baseUrl: 'http://169.254.169.254/' } } }),
    /metadata|link-local/i,
    'metadata IP must be rejected'
  );
  assert.throws(
    () => mergeConfigUpdate(current, { providers: { openai: { enabled: true, baseUrl: 'http://metadata.google.internal/' } } }),
    ConfigValidationError
  );
  // a normal endpoint still validates
  assert.doesNotThrow(() =>
    mergeConfigUpdate(current, { providers: { openai: { enabled: true, baseUrl: 'https://api.openai.com', apiKey: 'sk-x' } } })
  );
});

test('safeFetch refuses to follow redirects (SSRF via 3xx bypass)', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => { calls.push({ url, redirect: opts?.redirect }); return Promise.resolve({ ok: true }); };
  try {
    await safeFetch('https://api.example.com/v1/models', { method: 'GET' });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].redirect, 'error', 'safeFetch must set redirect:error so a 3xx cannot chase a metadata URL');
});

test('every provider routes outbound calls through safeFetch, not bare fetch', () => {
  for (const file of ['src/providers/ollama.js', 'src/providers/openai.js', 'src/providers/anthropic.js']) {
    const source = read(file);
    assert.doesNotMatch(source, /await fetch\(/, `${file} must not call bare fetch()`);
    assert.match(source, /safeFetch\(/, `${file} must use safeFetch()`);
  }
});

test('HSTS is opt-in and only emitted for TLS deployments', () => {
  const withHsts = new Map();
  applySecurityHeaders({ setHeader: (k, v) => withHsts.set(k, v) }, { hsts: true });
  assert.match(withHsts.get('strict-transport-security') || '', /max-age=\d+/);
  assert.match(withHsts.get('content-security-policy') || '', /frame-ancestors 'none'/);

  const noHsts = new Map();
  applySecurityHeaders({ setHeader: (k, v) => noHsts.set(k, v) }); // default: plain HTTP
  assert.equal(noHsts.has('strict-transport-security'), false, 'plain-HTTP install must not send HSTS');
});

test('the container runs as a non-root user', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /adduser -S/, 'must create a system user');
  assert.match(dockerfile, /USER sovereign/, 'must switch to the non-root user');
  assert.match(dockerfile, /chown -R sovereign:sovereign \/state/, 'state must be owned by the app user');
});
