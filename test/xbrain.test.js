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

// The same rule as the knowledge search (ADR-27): a probe ends in the passage
// that answered it. The Atlas had every found signal in hand — the route
// returns rank order, focus windows and covered terms — and was printing a
// score column beside the first 280 characters of a chunk instead.
test('the Atlas reads its deepest sounding, and lists only what came after it', () => {
  const script = scriptOf(surfaces.atlas);
  assert.match(script, /function renderSoundings/, 'the soundings are rendered as a find, not a table');
  assert.match(script, /the deepest sounding/, 'the passage that answered is named as such');
  assert.match(script, /best\.focus \|\|/, 'the focus window leads, with the chunk slice only as a fallback');
  assert.match(script, /the terrain also answered/, 'the rest stay soundings — quietly');
  assert.doesNotMatch(script, /content \|\| ''\)\.slice\(0, 280\)\}<\/span>/, 'the old 280-character slab is gone');

  // Escape first, then mark: nothing from a document may reach the DOM as markup.
  assert.match(script, /function markTerms/);
  assert.match(script, /const safe = esc\(String\(text \?\? ''\)\);/, 'escaping happens before any mark is inserted');
  assert.match(script, /\[\.\*\+\?\^\$\{\}\(\)\|\[\\\]\\\\\]/, 'query terms are escaped before becoming a RegExp');

  // The public demo must answer in the shape the real route returns — a
  // fixture that drops fields the UI reads only ever breaks in public.
  const demo = script.slice(script.indexOf('function demoProbe'), script.indexOf('async function boot'));
  for (const field of ['documentId', 'document', 'content', 'score', 'method', 'rank', 'coverage', 'terms', 'focus']) {
    assert.match(demo, new RegExp(`\\b${field}\\s*[:,}]`), `the demo fixture must carry ${field}`);
  }
  assert.match(demo, /sort\(\(a, b\) => b\.rank - a\.rank\)/, 'and order by rank, as the server does');

  // One depth function for the hexagons, the ordering and the numbers beside
  // the soundings. Lighting by `score` while ordering by `rank` let the best
  // find read LOWER than a runner-up directly beneath it.
  assert.match(script, /function depthOf/);
  assert.match(script, /Number\.isFinite\(result\?\.rank\) \? result\.rank/, 'rank is the ordering the AI actually uses');
  assert.doesNotMatch(script, /\(hit\.score \?\? 0\)\.toFixed\(2\)/, 'the hexagons no longer light by a signal the ordering ignores');
  assert.match(script, /depthOf\(hit\) \/ deepest/, 'depth is shown relative to the best answer — raw rank has no ceiling to read against');
  assert.match(surfaces.atlas, /retrieval rank/, 'and the page claims rank, which is what it now shows');

  assert.match(surfaces.atlas, /\.found-quote/, 'the found passage has a voice of its own on the page');
  assert.match(surfaces.atlas, /mark \{ background: transparent/, 'marks are drawn in the map’s own gold, not a highlighter');
});
