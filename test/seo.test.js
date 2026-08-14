// The public marketing site on mysovereign.ai must stay discoverable by search
// engines and answer engines, and must never drift from what the product
// actually is. These tests pin the machine-readable surface: crawl rules,
// canonical URLs, structured data, and the claims we refuse to make.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pub = (file) => fs.readFileSync(path.join(root, 'public', file), 'utf8');

const SITE = 'https://mysovereign.ai';
// Every public page, with the clean path it is served at.
const PAGES = [
  ['land.html', '/'],
  ['what-is-sovereign-ai.html', '/what-is-sovereign-ai'],
  ['sovereignty.html', '/sovereignty'],
  ['why.html', '/why'],
  ['faq.html', '/faq'],
  ['playground.html', '/playground'],
  ['film.html', '/film'],
  ['a-day.html', '/a-day'],
];

// The playground: the product's real interface files, publicly hosted in
// their honestly-badged demo mode. Surfaces stand under their own names; the
// xbrain* filenames are internal fossils (the local server serves them at
// those paths), and the retired umbrella must never resurface in public copy.
const DEMO_SURFACES = [
  ['xbrain.html', 'xbrain.js', '/mind-field'],
  ['xbrain-ledger.html', 'xbrain-ledger.js', '/memory-ledger'],
  ['xbrain-atlas.html', 'xbrain-atlas.js', '/knowledge-atlas'],
  ['guide.html', 'guide.js', '/guide'],
];

test('every public page carries a canonical URL, a description, and sharing metadata', () => {
  for (const [file, route] of PAGES) {
    const html = pub(file);
    assert.match(html, /<meta name="description" content="[^"]{80,}"/, `${file} needs a substantial description`);
    assert.ok(
      html.includes(`<link rel="canonical" href="${SITE}${route}"`),
      `${file} must declare its canonical URL as ${SITE}${route}`
    );
    assert.match(html, /property="og:title"/, `${file} needs an Open Graph title`);
    assert.match(html, /name="twitter:card"/, `${file} needs a Twitter card`);
    assert.match(html, /<html lang="en">/, `${file} must declare its language`);
  }
});

test('structured data is present and parses as valid JSON on every page', () => {
  for (const [file] of PAGES) {
    const blocks = [...pub(file).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    assert.ok(blocks.length > 0, `${file} must publish structured data`);
    for (const [, json] of blocks) {
      assert.doesNotThrow(() => JSON.parse(json), `${file} has malformed JSON-LD`);
      assert.match(json, /"@context": "https:\/\/schema\.org"/, `${file} JSON-LD needs a schema.org context`);
    }
  }
});

test('the FAQ answers in the markup match the answers given to answer engines', () => {
  const html = pub('faq.html');
  const [, json] = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  const faq = JSON.parse(json);
  assert.equal(faq['@type'], 'FAQPage');
  assert.ok(faq.mainEntity.length >= 10, 'a thin FAQ is not worth citing');
  const visible = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  for (const entry of faq.mainEntity) {
    assert.equal(entry['@type'], 'Question');
    // Structured data that says something the page does not is cloaking.
    const opening = entry.acceptedAnswer.text.split('.')[0].replace(/\s+/g, ' ').trim();
    assert.ok(
      visible.includes(opening),
      `FAQ answer "${entry.name}" is in the structured data but not visible on the page`
    );
  }
});

test('crawlers are told where to go, and answer engines are explicitly welcome', () => {
  const robots = pub('robots.txt');
  assert.match(robots, new RegExp(`Sitemap: ${SITE}/sitemap\\.xml`), 'robots.txt must advertise the sitemap');
  // The whole point of this site is to be quoted — no answer engine is blocked.
  for (const bot of ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'OAI-SearchBot', 'CCBot']) {
    assert.match(robots, new RegExp(`User-agent: ${bot}\\s*\\nAllow: /`), `${bot} must be explicitly allowed`);
  }
  assert.doesNotMatch(robots, /^\s*Disallow: \/\s*$/m, 'nothing on the marketing site may be walled off');

  const sitemap = pub('sitemap.xml');
  for (const [, route] of PAGES) {
    assert.ok(sitemap.includes(`<loc>${SITE}${route}</loc>`), `sitemap is missing ${route}`);
  }
});

test('llms.txt gives answer engines the product, the license, and the limits', () => {
  const llms = pub('llms.txt');
  assert.match(llms, /^# SovereignAI/m);
  assert.match(llms, /FSL-1\.1-MIT/, 'the license must be stated where models will read it');
  assert.match(llms, /fair source, not open source/i, 'the licensing distinction must be unambiguous');
  // If a model is going to summarize us, it should carry the caveats too.
  assert.match(llms, /not encrypted at rest/i, 'the at-rest gap must travel with the summary');
  for (const [, route] of PAGES.slice(1)) {
    assert.ok(llms.includes(`${SITE}${route}`), `llms.txt should point at ${route}`);
  }
});

test('the public site never claims to be open source, and never links the private repo', () => {
  for (const [file] of PAGES) {
    const html = pub(file);
    // The phrase is allowed — "Is SovereignAI open source?" is a question real
    // people ask, and answering it is worth the traffic. What is forbidden is
    // letting it stand alone: the correction must always travel with the term.
    for (const match of html.matchAll(/open[- ]source/gi)) {
      const context = html.slice(Math.max(0, match.index - 300), match.index + 300);
      assert.match(
        context,
        /fair source/i,
        `${file} says "open source" without "fair source" nearby — the core is FSL-licensed`
      );
    }
    assert.doesNotMatch(html, /github(?:usercontent)?\.com\/mlmrx/, `${file} links a private repo that 404s for visitors`);
    // The rival framing concedes the model layer; ours is a dial, not a trade.
    assert.doesNotMatch(html, /rent the intelligence/i, `${file} uses the competitor's framing`);
  }
  const llms = pub('llms.txt');
  assert.doesNotMatch(llms, /github(?:usercontent)?\.com\/mlmrx/);
});

test('one shell frames every page: same header, same footer, same theme control', () => {
  // The site felt like separate sites because it was: four hand-rolled headers,
  // three link orders, and a theme picker that existed only on the landing.
  // Deliberately short: brand, three destinations, one call to action. Depth
  // pages (thesis, what-is, a-day, access) live in the footer, which carries
  // every link — a nav is a choice, not an inventory.
  const NAV = ['/film', '/playground', '/sovereignty', '/faq'];
  for (const [file] of [...PAGES, ['film.html']]) {
    const html = pub(file);
    assert.match(html, /<header class="shell-bar">/, `${file} must carry the shared header`);
    assert.match(html, /<footer class="shell-foot">/, `${file} must carry the shared footer`);
    assert.match(html, /shell\.css/, `${file} must load the shell styles`);
    assert.match(html, /shell\.js/, `${file} must load the shell behaviour`);
    // The theme choice is reachable from every page, not just the landing.
    assert.match(html, /data-theme-mount/, `${file} needs the theme control`);
    // Identical link set, in identical order, so nothing moves as you browse.
    const links = html.match(/<nav class="shell-links">([\s\S]*?)<\/nav>/)[1];
    const hrefs = [...links.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((h) => h.startsWith('/') && !h.includes('#'));
    assert.deepEqual(hrefs, NAV, `${file} nav must match the canonical order`);
    // Everything cut from the bar must still be reachable from the footer.
    const foot = html.match(/<footer class="shell-foot">([\s\S]*?)<\/footer>/)[1];
    for (const href of ['/why', '/what-is-sovereign-ai', '/a-day', '/#access']) {
      assert.ok(foot.includes(`href="${href}"`), `${file} footer must still reach ${href}`);
    }
  }
  // The landing's section row is gone: its own CTAs already do that work.
  assert.doesNotMatch(pub('land.html'), /shell-sub/, 'no second nav row on the landing');
  // Every surface that paints its own tokens understands the named themes, so
  // a choice survives the jump between pages. (film.css is exempt on purpose:
  // a cinema commits to one look.)
  for (const sheet of ['doc.css', 'land.html', 'a-day.html']) {
    for (const theme of ['cielo', 'bottega', 'notte']) {
      assert.ok(pub(sheet).includes(`:root[data-theme="${theme}"]`), `${sheet} must define ${theme}`);
    }
    // A mistyped token silently falls back to the default look; catch it here.
    for (const [, value] of pub(sheet).matchAll(/--[\w-]+:\s*(#[0-9a-zA-Z]+)/g)) {
      assert.match(value, /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, `${sheet} has a malformed colour ${value}`);
    }
  }
  assert.match(pub('shell.js'), /sovereign-theme/, 'the shell owns the stored choice');
  assert.doesNotMatch(pub('land.js'), /theme-menu|localStorage\.setItem\('sovereign-theme'/, 'the landing must not keep a second theme system');
});

test('visitor counting is cookie-less and disclosed on every page that carries it', () => {
  for (const [file] of PAGES) {
    const html = pub(file);
    assert.match(html, /_vercel\/insights\/script\.js/, `${file} must carry the counting script`);
    // A privacy brand that counts visitors says so where it happens, and
    // separates the site's counting from the product's architecture.
    assert.match(html, /cookie-less/i, `${file} must disclose the counting in plain sight`);
    assert.match(html, /reports nothing to anyone/i, `${file} must state the product-vs-site distinction`);
  }
});

test('the playground ships real interfaces, guarded for the public origin', () => {
  const config = JSON.parse(pub('vercel.json'));
  const routes = new Map(config.rewrites.map((r) => [r.source, r.destination]));
  const ignore = pub('.vercelignore');
  const hub = pub('playground.html');
  for (const [html, js, route] of DEMO_SURFACES) {
    assert.equal(routes.get(route), `/${html}`, `${route} must serve ${html}`);
    assert.ok(ignore.includes(`!${html}`) && ignore.includes(`!${js}`), `${html}+${js} must be deployed`);
    assert.ok(hub.includes(`href="${route}"`), `the playground hub must link ${route}`);
    const script = pub(js);
    // A real install's #token= link pasted on the public origin must never
    // persist or transmit a credential.
    assert.match(script, /PUBLIC_DEMO_HOST/, `${js} needs the public-origin guard`);
    assert.match(script, /if \(PUBLIC_DEMO_HOST\) return \{\};/, `${js} must never send auth headers on the public origin`);
    // The badge must not claim "no server reachable" on a host that is
    // reachable and simply has no server behind it.
    assert.match(script, /fictional data, no server behind this page/, `${js} needs the honest public badge`);
    assert.match(script, /href="\/playground"/, `${js} must offer the way back to the playground`);
  }
  const sitemap = pub('sitemap.xml');
  for (const [, , route] of DEMO_SURFACES) {
    assert.ok(sitemap.includes(`<loc>${SITE}${route}</loc>`), `sitemap is missing ${route}`);
  }
  // The internal note about how the founder works stays out of public demo data.
  assert.doesNotMatch(pub('xbrain.js'), /flag only strategic business calls/, 'no internal operating notes in demo memories');
  // Old umbrella URLs redirect permanently to the surface names.
  const redirects = new Map((config.redirects || []).map((r) => [r.source, r]));
  for (const [oldPath, target] of [
    ['/xbrain', '/mind-field'], ['/xbrain.html', '/mind-field'],
    ['/xbrain-ledger', '/memory-ledger'], ['/xbrain-ledger.html', '/memory-ledger'],
    ['/xbrain-atlas', '/knowledge-atlas'], ['/xbrain-atlas.html', '/knowledge-atlas'],
  ]) {
    const rule = redirects.get(oldPath);
    assert.ok(rule && rule.destination === target && rule.permanent === true, `${oldPath} must 301 to ${target}`);
  }
  // The retired umbrella never resurfaces where the public reads: page titles,
  // the hub, the sitemap, or what we hand to answer engines.
  for (const file of ['playground.html', 'llms.txt', 'sitemap.xml']) {
    assert.doesNotMatch(pub(file), /xbrain/i, `${file} must not carry the retired umbrella name`);
  }
  for (const [html] of DEMO_SURFACES) {
    assert.doesNotMatch(pub(html).match(/<title>[^<]*<\/title>/)[0], /xbrain/i, `${html} title must use the surface's own name`);
  }
});

test('the film and the day replay argue without a video file, and read without motion', () => {
  const film = pub('film.html');
  const filmJs = pub('film.js');
  // No video asset anywhere: the film is code, which is the argument.
  // Extension boundaries matter here: canvas drawing is full of .moveTo().
  assert.doesNotMatch(film + filmJs, /<video[\s>]|\.mp4\b|\.webm\b|\.mov\b/i, 'the film ships as code, not as a media file');
  // The written cut is in the markup itself, so it survives no JS and reduced
  // motion — and the honesty beat is never the part that gets cut.
  assert.match(film, /<article class="read"/, 'the written cut must exist in the markup');
  assert.match(film, /isn’t sovereign|isn't sovereign/, 'the film must carry the not-yet-sovereign beat');
  assert.match(filmJs, /prefers-reduced-motion/, 'the film must respect reduced motion');
  assert.match(filmJs, /if \(!REDUCE\) start\(\);/, 'reduced motion keeps the written cut instead of animating');
  // Sound stays behind a press, per the standing decision against autoplay.
  assert.match(filmJs, /soundOn = !soundOn/, 'sound is a toggle the viewer presses');
  assert.doesNotMatch(filmJs, /autoplay/i, 'nothing about this page autoplays sound');

  const day = pub('a-day.html');
  // Every scene names a shipped mechanism; these are the ones it claims.
  for (const cli of ['import-chat', 'sovereign mcp', 'start --lan', 'import-email']) {
    assert.ok(day.includes(cli), `a-day claims ${cli} — keep the claim or drop the scene`);
  }
  // The rival framing stays out of the copy that describes renting a model.
  assert.doesNotMatch(day, /rent the intelligence/i, 'never concede the model layer in copy');
});

test('every public page is reachable: routes are wired and internal links resolve', () => {
  const config = JSON.parse(pub('vercel.json'));
  const routes = new Map(config.rewrites.map((r) => [r.source, r.destination]));
  for (const [file, route] of PAGES) {
    assert.equal(routes.get(route), `/${file}`, `${route} must serve ${file}`);
  }
  const ignore = pub('.vercelignore');
  for (const file of [...PAGES.map(([f]) => f), 'robots.txt', 'sitemap.xml', 'llms.txt', 'doc.css']) {
    assert.ok(ignore.includes(`!${file}`), `${file} would not be deployed — add it to .vercelignore`);
  }
  // A link to a clean route that no rewrite serves is a 404 in production.
  const known = new Set([...routes.keys(), '/#access']);
  for (const [file] of PAGES) {
    for (const [, href] of pub(file).matchAll(/href="(\/[^"#]*)"/g)) {
      if (href.endsWith('.css') || href.endsWith('.js') || href.endsWith('.xml') || href.endsWith('.txt')) continue;
      assert.ok(known.has(href), `${file} links ${href}, which no route serves`);
    }
  }
});
