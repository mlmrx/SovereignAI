import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'xbrain.html'), 'utf8');
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));

test('XBrain markup has unique ids and every selector it uses resolves', () => {
  const ids = [...html.matchAll(/\bid="([A-Za-z][\w:-]*)"/g)].map((match) => match[1]);
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  assert.deepEqual(duplicates, [], `duplicate ids: ${duplicates.join(', ')}`);

  const referenced = [...script.matchAll(/\$\(['"]#([A-Za-z][\w-]*)['"]\)/g)].map((match) => match[1]);
  const missing = [...new Set(referenced.filter((id) => !ids.includes(id)))];
  assert.deepEqual(missing, [], `selectors missing from xbrain.html: ${missing.join(', ')}`);
});

test('XBrain bundle parses and keeps the cognition-loop contracts wired', () => {
  assert.doesNotThrow(() => new vm.Script(script, { filename: 'public/xbrain.html' }));

  // live mode speaks the same API the classic UI does
  assert.match(script, /fetch\('\/api\/chat'/);
  for (const event of ['meta', 'delta', 'done', 'error']) {
    assert.match(script, new RegExp(`packet\\.event === '${event}'`), `must handle SSE ${event}`);
  }
  assert.match(script, /'POST', '\/api\/memories', \{ content \}/, 'keep chip must use the memories contract');
  assert.match(script, /localStorage\.getItem\('sovereign-token'\)/, 'must reuse the classic UI token store');

  // the reimagined primitives: cortex ignition, three faces, consent, demo fallback
  for (const primitive of ['function ignite', 'function addCell', "data-face=\"recall\"", "data-face=\"trace\"", 'keep-chip', 'function bootDemo']) {
    assert.ok(html.includes(primitive), `missing primitive: ${primitive}`);
  }
  assert.match(script, /prefers-reduced-motion/, 'motion must respect reduced-motion');

  // the voice renders escaped-first markdown — never raw model HTML
  assert.match(script, /const safe = esc\(text\);/);
});
