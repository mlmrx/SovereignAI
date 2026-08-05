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
});

test('the landing page carries the brand and both themes', () => {
  assert.match(html, /%23d97757/, 'favicon uses the terracotta brand mark');
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /data-theme="dark"/);
  assert.match(html, /prefers-reduced-motion/);
  // value props and the exit-path moat are the strategic spine of the page
  assert.match(html, /sovereignty ledger|What you get/i);
  assert.match(html, /exit path/i);
  assert.match(script, /const PROPS =/, 'value props are enumerated');
});
