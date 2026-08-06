import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'land.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'public', 'land.js'), 'utf8');

test('the landing page parses, has unique ids, and resolves every selector it uses', () => {
  assert.doesNotThrow(() => new vm.Script(script, { filename: 'public/land.html' }));
  const ids = [...html.matchAll(/\bid="([A-Za-z][\w:-]*)"/g)].map((m) => m[1]);
  const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  assert.deepEqual(duplicates, [], `duplicate ids: ${duplicates.join(', ')}`);
  const referenced = [...script.matchAll(/\$\(['"]#([A-Za-z][\w-]*)['"]\)/g)].map((m) => m[1]);
  const missing = [...new Set(referenced.filter((id) => !ids.includes(id)))];
  assert.deepEqual(missing, [], `selectors missing from land.html: ${missing.join(', ')}`);
});

test('the landing page is a public, dataless marketing surface (no token, no workspace calls)', () => {
  // It must NOT read the auth token or hit any private workspace API — this is the one page safe to expose publicly.
  assert.doesNotMatch(script, /sovereign-token/, 'landing page must not touch the auth token');
  assert.doesNotMatch(script, /\/api\/(status|chat|memories|documents|config|personas|model-recipes)/, 'landing page must not call private workspace APIs');
});

test('the waitlist form captures interest and never silently drops a lead', () => {
  assert.match(html, /id="wl-form"/);
  assert.match(html, /type="email"/);
  assert.match(script, /WAITLIST_ENDPOINT/, 'submission target must be configurable');
  assert.match(script, /mailto:/, 'must fall back to email so interest is never lost');
  assert.match(script, /fetch\(window\.WAITLIST_ENDPOINT/, 'a configured endpoint must receive a POST');
  assert.match(script, /\/\^\[\^\\s@\]\+@/, 'email must be validated before submit');
  // CSP forbids inline scripts, so window globals can never be set on the
  // served page — configuration must come from markup the script reads.
  assert.match(html, /meta name="waitlist-endpoint"/, 'endpoint must be configurable without inline JS');
  assert.match(html, /meta name="waitlist-email"/, 'fallback address must be configurable without inline JS');
  assert.match(script, /meta\[name="waitlist-endpoint"\]/, 'script must read the endpoint from markup');
  assert.doesNotMatch(html + script, /sovereignai\.app/, 'never point leads at a domain we do not own');
  assert.match(script, /not in the queue until/i, 'the mailto fallback must not overclaim success');
});

test('private early access: every path funnels to a work-email-validated access request', () => {
  assert.match(html, /id="access"/, 'the access-request band exists');
  // The repo is private: public links to it would 404 for every visitor.
  assert.doesNotMatch(html, /github(?:usercontent)?\.com\/mlmrx/, 'no links to the private repo on the public page');
  assert.match(html, /btn-primary" href="#access"/, 'the hero primary CTA leads to the access request');
  assert.match(html, /class="join" href="#access"/, 'the nav CTA leads to the access request');
  assert.match(html, /id="wl-company"/, 'company is captured (optional)');
  // The work-email gate: personal domains are declined with an explanation
  // and a direct escape hatch, so validation never silently drops a lead.
  assert.match(script, /FREE_MAIL/, 'a personal-mail domain list gates the form');
  for (const domain of ["'gmail.com'", "'outlook.com'", "'icloud.com'", "'proton.me'"]) {
    assert.ok(script.includes(domain), `${domain} must be treated as personal`);
  }
  assert.match(script, /work email so we can verify/i, 'the decline explains itself');
  assert.match(script, /No work email\?/i, 'personal-address requesters get a direct path, never a dead end');
});

test('the first-week story: exactly ten moments, each visual and each backed by a shipped receipt', () => {
  assert.match(html, /id="week"/, 'the story band exists');
  assert.equal((html.match(/class="moment"/g) ?? []).length, 10, 'the story tells exactly ten unlocks');
  assert.equal((html.match(/class="m-ic"/g) ?? []).length, 10, 'every moment carries a pictogram');
  assert.equal((html.match(/class="m-receipt"/g) ?? []).length, 10, 'every moment names its shipped mechanism');
  // Receipts must name real, shipped mechanisms — the credibility contract of the band.
  for (const receipt of [
    'import-chat --distill', 'import-email', 'secure_delete',
    'sovereign export --encrypt', 'sovereign verify', 'sovereign mcp',
    'cognition stays home', 'weight-digest receipts', 'BM25',
  ]) {
    assert.ok(html.includes(receipt), `a receipt must name: ${receipt}`);
  }
  // Reveal is opt-in: no JS or reduced motion must leave the story fully readable.
  assert.match(script, /story-anim/, 'reveal styles are gated behind a JS-added class');
  assert.match(script, /IntersectionObserver/, 'moments reveal as the reader reaches them');
  assert.match(script, /REDUCE\.matches[\s\S]{0,80}return/, 'reduced motion must skip the reveal entirely');
});

test('the landing page carries the brand and both themes', () => {
  assert.match(html, /%23d97757/, 'favicon uses the terracotta brand mark');
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /data-theme="dark"/);
  assert.match(html, /prefers-reduced-motion/);
  // Named themes: viewer-chosen, one virtue each, legacy values still honored.
  for (const theme of ['cielo', 'bottega', 'notte']) {
    assert.match(html, new RegExp(`data-theme="${theme}"`), `missing ${theme} token block`);
    assert.match(html, new RegExp(`data-theme-pick="${theme}"`), `missing ${theme} picker option`);
  }
  assert.match(script, /LEGACY = \{ dark: 'notte', light: 'bottega' \}/, 'stored legacy themes must migrate, not reset');
  assert.match(html, /remembered on your device and nowhere else/i, 'the picker must state its privacy');
  // value props and the exit-path moat are the strategic spine of the page
  assert.match(html, /sovereignty ledger|What you get/i);
  assert.match(html, /exit path/i);
  assert.match(script, /const PROPS =/, 'value props are enumerated');
});
