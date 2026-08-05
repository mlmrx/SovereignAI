import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const surfaces = {
  dialogue: fs.readFileSync(path.join(root, 'public', 'xbrain.html'), 'utf8'),
  ledger: fs.readFileSync(path.join(root, 'public', 'xbrain-ledger.html'), 'utf8'),
  atlas: fs.readFileSync(path.join(root, 'public', 'xbrain-atlas.html'), 'utf8'),
};
// Bundles are external files (CSP: script-src 'self' forbids inline) — load
// the file each page actually references.
const scriptOf = (html) => {
  const src = html.match(/<script src="([^"]+)"><\/script>/)?.[1];
  assert.ok(src, 'every surface must load its bundle via <script src> (inline scripts are blocked by CSP)');
  return fs.readFileSync(path.join(root, 'public', src), 'utf8');
};

test('every XBrain surface has unique ids, resolvable selectors, and a parsing bundle', () => {
  for (const [name, html] of Object.entries(surfaces)) {
    const script = scriptOf(html);
    assert.doesNotThrow(() => new vm.Script(script, { filename: `public/xbrain-${name}` }), `${name} bundle must parse`);

    const ids = [...html.matchAll(/\bid="([A-Za-z][\w:-]*)"/g)].map((match) => match[1]);
    const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    assert.deepEqual(duplicates, [], `${name}: duplicate ids: ${duplicates.join(', ')}`);

    const referenced = [...script.matchAll(/\$\(['"]#([A-Za-z][\w-]*)['"]\)/g)].map((match) => match[1]);
    const missing = [...new Set(referenced.filter((id) => !ids.includes(id)))];
    assert.deepEqual(missing, [], `${name}: selectors missing from markup: ${missing.join(', ')}`);

    // shared covenants of the design system
    assert.match(script, /localStorage\.getItem\('sovereign-token'\)/, `${name} must reuse the classic UI token store`);
    assert.match(script, /function bootDemo|state\.demo = true/, `${name} must have a demo fallback`);
    assert.match(html, /prefers-reduced-motion/, `${name} must respect reduced motion`);
    assert.match(html, /prefers-color-scheme: dark/, `${name} must design both themes`);
    assert.match(html, /data-theme="dark"/, `${name} must honor the viewer theme override`);
  }
});

test('the triptych cross-links all three surfaces', () => {
  assert.match(surfaces.dialogue, /href="\/xbrain-ledger\.html"/);
  assert.match(surfaces.dialogue, /href="\/xbrain-atlas\.html"/);
  assert.match(surfaces.ledger, /href="\/xbrain\.html"/);
  assert.match(surfaces.ledger, /href="\/xbrain-atlas\.html"/);
  assert.match(surfaces.atlas, /href="\/xbrain\.html"/);
  assert.match(surfaces.atlas, /href="\/xbrain-ledger\.html"/);
});

test('Dialogue keeps the cognition-loop contracts wired', () => {
  const script = scriptOf(surfaces.dialogue);
  assert.match(script, /fetch\('\/api\/chat'/);
  for (const event of ['meta', 'delta', 'done', 'error']) {
    assert.match(script, new RegExp(`packet\\.event === '${event}'`), `must handle SSE ${event}`);
  }
  assert.match(script, /'POST', '\/api\/memories', \{ content \}/, 'keep chip must use the memories contract');
  assert.match(script, /meta\.memories/, 'memory ignition must be driven by reported recall, not guesses');
  for (const primitive of ['function ignite', 'function addCell', 'data-face="recall"', 'data-face="trace"', 'keep-chip']) {
    assert.ok(surfaces.dialogue.includes(primitive) || script.includes(primitive), `missing primitive: ${primitive}`);
  }
  assert.match(script, /const safe = esc\(text\);/, 'the voice renders escaped-first markdown');
});

test('the Mind Field stays honest machinery with an accessible door', () => {
  const script = scriptOf(surfaces.dialogue);
  assert.match(surfaces.dialogue, /<canvas id="mindfield"/, 'the cortex is a full-viewport canvas field');
  assert.match(script, /cell\.kind === 'document' && docIds\.has\(cell\.id\)/, 'document ignition maps to real source ids');
  assert.match(script, /cell\.kind === 'memory' && memoryIds\.has\(cell\.id\)/, 'memory ignition maps to reported recall ids');
  assert.match(script, /first token in \$\{Math\.round\(firstToken\)\} ms/, 'latency is measured, not implied');
  assert.match(script, /REDUCED\.matches|prefers-reduced-motion/, 'field animation must respect reduced motion');
  assert.match(surfaces.dialogue, /cortex-index/, 'the field must have a keyboard-accessible index');
  for (const html of Object.values(surfaces)) {
    assert.match(html, /@view-transition \{ navigation: auto; \}/, 'surfaces share cross-page transitions');
  }
});

test('the chat meta event truthfully reports recalled memories to clients', () => {
  const chat = fs.readFileSync(path.join(root, 'src', 'chat.js'), 'utf8');
  assert.match(chat, /sse\.send\('meta', \{[\s\S]*?memories,[\s\S]*?\}\)/, 'meta must carry recalled memories');
  assert.match(chat, /memories = selected\.map\(\(m\) => \(\{ id: m\.id, excerpt/, 'reported memories must be the ones placed in the prompt');
});

test('Ledger wires inscribe, amend, strike, and filter to the memories API', () => {
  const script = scriptOf(surfaces.ledger);
  assert.match(script, /'POST', '\/api\/memories', \{ content \}/);
  assert.match(script, /'PUT', `\/api\/memories\/\$\{encodeURIComponent\(entry\.id\)\}`/);
  assert.match(script, /'DELETE', `\/api\/memories\/\$\{encodeURIComponent\(entry\.id\)\}`/);
  assert.match(script, /confirmStrike/, 'revocation must be confirmed');
  assert.match(surfaces.ledger, /class="spine"/, 'entries hang on the spine');
  assert.match(script, /state\.filter/, 'the record must be searchable');
});

test('Atlas probes the terrain with real retrieval and surveys territories', () => {
  const script = scriptOf(surfaces.atlas);
  assert.match(script, /\/api\/search\?q=\$\{encodeURIComponent\(query\)\}/, 'the probe must use real retrieval');
  assert.match(script, /'GET', '\/api\/documents'/);
  assert.match(script, /'DELETE', `\/api\/documents\/\$\{encodeURIComponent\(territory\.id\)\}`/);
  assert.match(script, /best\.get\(territory\.id\)/, 'territories light by their true best score');
  assert.match(surfaces.atlas, /class="terrain"/);
  assert.match(script, /demoProbe/, 'demo probe must be clearly separate from live retrieval');
});
