import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ssrfBlockedReason } from '../src/config.js';
import { dockerRunCommand } from '../src/byoc/connector.js';
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
