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

test('the open trial is real and un-gated: one command, token required, exit printed beside it', () => {
  assert.match(html, /btn-primary" href="#install"/, 'the hero primary CTA leads to the trial, not a form');
  assert.match(
    html,
    /docker run -d --name sovereign[^<]*-e SOVEREIGN_TOKEN=[^<]*ghcr\.io\/mlmrx\/sovereignai:latest/,
    'the one-command trial is on the page, with the token the container requires for any outside access'
  );
  assert.match(html, /#token=/, 'the post-run URL carries the token in the hash, where proxies and logs never see it');
  assert.match(html, /docker rm -f sovereign/, 'the teardown is printed next to the invitation — the exit before the door');
  assert.match(script, /#run-copy/, 'the command is copyable in one click');
});

test('the access request remains the door for binaries, source, and the managed edition', () => {
  assert.match(html, /id="access"/, 'the access-request band exists');
  // The repo is private: public links to it would 404 for every visitor.
  assert.doesNotMatch(html, /github(?:usercontent)?\.com\/mlmrx/, 'no links to the private repo on the public page');
  // The bar is deliberately short, so the footer is what guarantees the door
  // stays reachable from anywhere on the site.
  assert.match(html, /<footer class="shell-foot">[\s\S]*href="\/#access"/, 'the access request stays reachable from the footer');
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

test('the arrival can be heard: a retro om, synthesized in-page, only ever behind a click', () => {
  assert.match(html, /id="om-btn"/, 'the hero offers the om behind an explicit button');
  assert.match(script, /window\.AudioContext \|\| window\.webkitAudioContext/, 'the om is Web Audio synthesis, WebKit included');
  assert.doesNotMatch(html + script, /<audio|\.mp3|\.wav|\.ogg|\.m4a/, 'no audio asset — the sound is source code, zero requests');
  assert.match(script, /INTRO_MS \/ 1000/, 'the om is scheduled from the same constants that time the animation');
  assert.match(script, /finishIntro\(\); omDuck\(\);/, 'skipping the arrival also hushes the om');
  assert.match(script, /createWaveShaper/, 'the retro comes from a bitcrusher, not a sample');
  // No autoplay, no stored preference: the om exists only behind the click.
  assert.doesNotMatch(script, /sovereign-om/, 'no sound preference is stored — every om is freshly asked for');
});

test('the repossession story: exactly ten moments, each visual and each backed by a shipped receipt', () => {
  // The frame is acquisition copy, not an onboarding diary: the reader takes
  // themselves back, and the headline says so.
  assert.match(html, /Take <em>yourself<\/em> back\./, 'the band leads with the repossession');
  assert.match(html, /Seven days · one repossession/i, 'the eyebrow frames the week as a recovery');
  assert.doesNotMatch(html, /The first week it's actually yours/, 'the diary headline stays retired');
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

test('the ownership map is drawn, not just listed: twelve districts around one owner', () => {
  assert.match(html, /id="estate-map"/, 'the estate map exists');
  assert.equal((html.match(/class="estate-cell/g) ?? []).length, 12, 'twelve districts on the map');
  assert.equal((html.match(/data-own="/g) ?? []).length, 24, 'each district pairs with exactly one legend row');
  assert.match(html, /estate-core/, 'the owner sits at the center');
  assert.match(html, /estate-boat/, 'the boat waits off the coast — the exit is drawn, not promised');
  assert.match(html, /id="estate-caption"/, 'the caption narrates the hovered district');
  for (const label of ['>hardware<', '>runtime<', '>identity<', '>cognition<', '>exit<']) {
    assert.ok(html.includes(label), `district label ${label} on the map`);
  }
  assert.match(script, /estate-map/, 'cross-highlighting is wired');
  assert.match(script, /dataset\.own/, 'district and legend light together');
});

test('the landing page carries the brand and both themes', () => {
  assert.match(html, /%23d97757/, 'favicon uses the terracotta brand mark');
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /data-theme="dark"/);
  assert.match(html, /prefers-reduced-motion/);
  // Named themes: viewer-chosen, one virtue each, legacy values still honored.
  // The landing defines the looks; the shell offers them, on every page.
  const shell = fs.readFileSync(path.join(root, 'public', 'shell.js'), 'utf8');
  for (const theme of ['cielo', 'bottega', 'notte']) {
    assert.match(html, new RegExp(`data-theme="${theme}"`), `missing ${theme} token block`);
    assert.match(shell, new RegExp(`'${theme}'`), `the shared picker must offer ${theme}`);
  }
  assert.match(shell, /LEGACY = \{ dark: 'notte', light: 'bottega' \}/, 'stored legacy themes must migrate, not reset');
  assert.match(html, /remembered on your device and nowhere else/i, 'the picker must state its privacy');
  // value props and the exit-path moat are the strategic spine of the page
  assert.match(html, /sovereignty ledger|What you get/i);
  assert.match(html, /exit path/i);
  assert.match(script, /const PROPS =/, 'value props are enumerated');
});

test('the supported-today shelf promotes only what ships: dated, six groups, caveats on the chip', () => {
  assert.match(html, /id="latest"/, 'the shelf exists');
  assert.match(html, /Supported today · shelf dated (January|February|March|April|May|June|July|August|September|October|November|December) 20\d\d/, 'the shelf carries its date');
  assert.match(html, /class="hero-new" href="#latest"/, 'the hero points at the shelf');
  const band = html.slice(html.indexOf('id="latest"'), html.indexOf('id="week"'));
  assert.equal((band.match(/class="today-group/g) ?? []).length, 6, 'six groups on the shelf');
  // Every chip names a thing that ships — these are the ones the copy elsewhere also claims.
  for (const chip of ['Ollama', 'FreeToken', 'Claude', 'gpt-oss-120b', 'Qwen3.6-35B-A3B', 'Gemma 4 26B-A4B', 'gpt-oss-20b',
    'ChatGPT export', 'Claude export', 'Your inbox', 'MCP', 'VS Code', 'JetBrains', 'Browser extension', 'ChatGPT Custom GPT',
    'Docker', 'Single binary', 'Any box over SSH', 'Provenance on every memory', 'Verified export', 'Reasoning shown live']) {
    assert.ok(band.includes(`<b>${chip}`), `the shelf must carry ${chip}`);
  }
  // Caveats ride on the chip itself, never only in a footnote.
  assert.match(band, /class="chip pre"[^<]*<b>[^<]*<\/b><small>[^<]*preview/, 'a preview says so on its chip');
  assert.match(band, /class="chip exp"[^<]*<b>[^<]*<\/b><small>[^<]*experimental/, 'an experimental item says so on its chip');
  // Promotion never outruns the build: no unshipped platforms, no futures, no "open source".
  assert.doesNotMatch(band, /roadmap|coming soon|planned|Firefox|Safari|iOS|Android/i, 'nothing unshipped on the shelf');
  assert.doesNotMatch(band, /open source/i, 'the core is fair source');
  assert.match(band, /href="\/sovereignty"/, 'the shelf points at the audit that backs it');
});
