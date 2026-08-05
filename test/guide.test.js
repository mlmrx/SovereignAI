import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'guide.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'public', 'guide.js'), 'utf8');

test('the guide parses, has unique ids, and resolves every selector it uses', () => {
  assert.doesNotThrow(() => new vm.Script(script, { filename: 'public/guide.html' }));
  const ids = [...html.matchAll(/\bid="([A-Za-z][\w:-]*)"/g)].map((match) => match[1]);
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  assert.deepEqual(duplicates, [], `duplicate ids: ${duplicates.join(', ')}`);
  const referenced = [...script.matchAll(/\$\(['"]#([A-Za-z][\w-]*)['"]\)/g)].map((match) => match[1]);
  const missing = [...new Set(referenced.filter((id) => !ids.includes(id)))];
  assert.deepEqual(missing, [], `selectors missing from guide.html: ${missing.join(', ')}`);
});

test('waypoint progress is evidence from the live workspace, not decoration', () => {
  // the survey reads real endpoints
  for (const endpoint of ['/api/status', '/api/config', '/api/model-recipes', '/api/models?provider=ollama']) {
    assert.ok(script.includes(`'${endpoint}'`), `survey must read ${endpoint}`);
  }
  // auto-checks derive from workspace counts; manual acts admit they are manual
  assert.match(script, /counts\?\.conversations/, 'first-words must check real conversation counts');
  assert.match(script, /counts\?\.documents/, 'knowledge must check real document counts');
  assert.match(script, /counts\?\.memories/, 'memory must check real memory counts');
  assert.match(script, /manual: true/, 'unobservable acts must be explicitly manual');
  assert.match(script, /the guide takes your word/, 'manual marks must be labeled as self-reported');
  assert.match(script, /localStorage\.getItem\('sovereign-token'\)/, 'must reuse the classic UI token store');
  assert.match(script, /function bootDemo/, 'must fall back to a labeled demo workspace');
});

test('the guide covers the whole platform and shares the design covenants', () => {
  // The page's working surface is markup plus its external bundle (CSP
  // forbids inline scripts; waypoints render from guide.js).
  const page = html + script;
  for (const anchor of ['/#/chat', '/#/knowledge', '/#/memory', '/#/settings', '/#/finetune', '/xbrain.html', '/xbrain-ledger.html', '/xbrain-atlas.html']) {
    assert.ok(page.includes(`href="${anchor}"`), `guide must link to ${anchor}`);
  }
  for (const command of ['sovereign start', 'sovereign doctor', 'sovereign mcp', 'sovereign export', 'ollama pull nomic-embed-text', 'sovereign start --lan']) {
    assert.ok(page.includes(command), `guide must teach ${command}`);
  }
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /data-theme="dark"/);
  assert.match(html, /prefers-reduced-motion/);
  assert.match(html, /@view-transition \{ navigation: auto; \}/);
});
