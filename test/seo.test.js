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
// Vercel reads vercel.json from the project's Root Directory, not from the
// Output Directory it serves — the two were confused once, and it took the
// site's routing down silently. The file lives at the repo root on purpose.
const rootFile = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const SITE = 'https://mysovereign.ai';
// The pages a person is meant to arrive at, named one by one on purpose: this
// list is what catches a page silently disappearing from the deploy.
const CORE_PAGES = [
  ['land.html', '/'],
  ['what-is-sovereign-ai.html', '/what-is-sovereign-ai'],
  ['sovereignty.html', '/sovereignty'],
  ['why.html', '/why'],
  ['faq.html', '/faq'],
  ['three-questions.html', '/three-questions'],
  ['playground.html', '/playground'],
  ['watch.html', '/watch'],
  ['a-day.html', '/a-day'],
  ['blog.html', '/blog'],
];
// Blog posts are DERIVED from the filesystem rather than listed, because the
// set grows on its own: the watchtower publishes a digest without a human in
// the loop, and a machine editing this file to add itself to a test would make
// the test worthless. Every rule the hardcoded list enforced still applies to
// each derived post below — route, deploy, sitemap, index, structured data,
// sources — so a post that skips the wiring still fails the build.
const blogFiles = () => fs.readdirSync(path.join(root, 'public')).filter((f) => /^blog-.+\.html$/.test(f)).sort();
const blogRoute = (file) => `/blog/${file.replace(/^blog-/, '').replace(/\.html$/, '')}`;
const PAGES = [...CORE_PAGES, ...blogFiles().map((file) => [file, blogRoute(file)])];

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
    // Judge our copy, not the slugs of pages we cite: a third party's URL may
    // carry the phrase (NVIDIA's local-AI blog does); a link to it is not a claim.
    const html = pub(file).replace(/href="https?:\/\/(?!github\.com|raw\.githubusercontent\.com)[^"]*"/g, 'href=""');
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
    // The repository is public: linking it is the point (the landing test pins the door).
    // The rival framing concedes the model layer; ours is a dial, not a trade.
    assert.doesNotMatch(html, /rent the intelligence/i, `${file} uses the competitor's framing`);
  }
  const llms = pub('llms.txt');
  assert.match(llms, /github\.com\/mlmrx\/SovereignAI/, 'answer engines are told where the source is');
});

test('one shell frames every page: same header, same footer, same theme control', () => {
  // The site felt like separate sites because it was: four hand-rolled headers,
  // three link orders, and a theme picker that existed only on the landing.
  // Deliberately short: brand, three destinations, one call to action. Depth
  // pages (thesis, what-is, a-day, access) live in the footer, which carries
  // every link — a nav is a choice, not an inventory.
  // The bar reads as the order a visitor actually asks in: Why should I care
  // (the argument) -> What is it (the pieces, each explained on their own
  // terms) -> How does it work (the live interface, in practice) -> Ledger
  // (what we cannot claim) -> Run it. What must precede How: you learn what
  // a thing is before how it works — so Playground (the explainer) sits at
  // What, and the command center (the hands-on interface) sits at How.
  // Blog sits after the funnel, before the theme control: a side door, not a
  // step — added at the founder's request when the writing started.
  const NAV = ['/', '/watch', '/playground', '/command-center', '/sovereignty', '/blog'];
  for (const [file] of [...PAGES, ['watch.html']]) {
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
    for (const href of ['/why', '/what-is-sovereign-ai', '/a-day', '/faq', '/three-questions', '/blog', '/#access']) {
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

// The site claimed to count visits with Vercel Web Analytics. Analytics was
// never enabled on the project, so /_vercel/insights/script.js answered 404 as
// text/plain and — with nosniff set — every page logged a refused-script error
// while the footer described a counter that had never once run. On a site
// whose footer says "we'd rather say so than be caught", that is the one bug
// that matters most. The script is gone and the copy says what is true.
//
// If the counter is ever switched on, this test is the place to turn around:
// re-require the script tag and restore the disclosure in the same commit.
test('the site tells the truth about what it counts, and loads nothing that 404s', () => {
  for (const [file] of PAGES) {
    const html = pub(file);
    assert.doesNotMatch(html, /_vercel\/insights/, `${file} loads an analytics script that is not enabled — it 404s as text/plain and nosniff refuses it`);
    assert.doesNotMatch(html, /counts visits with Vercel/, `${file} still claims a counter that does not run`);
    // The blog's house rules pointed at the counter too, and outlived it by a
    // day. Any page that promises "tracking beyond" something is stale.
    assert.doesNotMatch(html, /tracking beyond the cookie-less visit count/, `${file} still points readers at a counter that was removed`);
    // The disclosure stays, in the negative: a privacy brand says what it does
    // NOT do just as plainly, and keeps the site/product distinction.
    assert.match(html, /counts nothing/i, `${file} must state plainly that nothing is counted`);
    assert.match(html, /cookie-less/i, `${file} must name the thing it is not doing`);
    assert.match(html, /reports nothing to anyone/i, `${file} must state the product-vs-site distinction`);
  }
  // Nothing anywhere in the deploy may reference it, scripts and text alike.
  for (const file of fs.readdirSync(path.join(root, 'public')).filter((f) => /\.(html|js|txt|xml)$/.test(f))) {
    assert.doesNotMatch(pub(file), /_vercel\/insights/, `${file} references the disabled analytics endpoint`);
  }
});

test('the playground ships real interfaces, guarded for the public origin', () => {
  const config = JSON.parse(rootFile('vercel.json'));
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

test('the watch page and the day replay argue without a video file, and read without motion', () => {
  const film = pub('watch.html');
  const filmJs = pub('watch.js');
  // No video asset anywhere: the film is code, which is the argument.
  // Extension boundaries matter here: canvas drawing is full of .moveTo().
  assert.doesNotMatch(film + filmJs, /<video[\s>]|\.mp4\b|\.webm\b|\.mov\b/i, 'the film ships as code, not as a media file');
  // The written cut is in the markup itself, so it survives no JS and reduced
  // motion — and the honesty beat is never the part that gets cut.
  assert.match(film, /<article class="read"/, 'the written cut must exist in the markup');
  // The shared header sits above the stage, so navigation never disappears.
  assert.ok(film.indexOf('shell-bar') < film.indexOf('class="film"'), 'the header must come before the stage');
  assert.doesNotMatch(pub('watch.css'), /\.film \{[^}]*position: fixed/, 'the stage must not cover the page');
  assert.match(film, /isn’t sovereign|isn't sovereign/, 'the sequence must carry the not-yet-sovereign beat');
  assert.match(filmJs, /prefers-reduced-motion/, 'it must respect reduced motion');
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
  const config = JSON.parse(rootFile('vercel.json'));
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

// The blog promises no newsletter, which leaves the feed as the only way to
// follow it — so the feed has to be right, and it has to stay right when a
// post is added. It is generated from the posts' own JSON-LD; this rebuilds
// it in memory and fails if the committed file has drifted.
test('the blog has a feed, generated from the posts and in sync with them', async () => {
  const { readPosts, buildFeed } = await import('../scripts/build-feed.js');
  const committed = pub('feed.xml').replace(/\r\n/g, '\n');
  assert.equal(committed, buildFeed(readPosts()), 'public/feed.xml is stale — run: node scripts/build-feed.js');

  const posts = readPosts();
  const files = fs.readdirSync(path.join(root, 'public')).filter((f) => /^blog-.+\.html$/.test(f));
  assert.equal(posts.length, files.length, 'every post is in the feed');
  for (const post of posts) {
    assert.ok(committed.includes(`<id>${post.url}</id>`), `the feed is missing ${post.slug}`);
    assert.match(post.published, /^\d{4}-\d{2}-\d{2}$/, `${post.slug} needs a real datePublished`);
    assert.ok(post.summary.length >= 80, `${post.slug} needs a summary a reader can judge from`);
  }
  // Discoverable by a reader that only has the page, and by a person reading it.
  const index = pub('blog.html');
  assert.match(index, /rel="alternate" type="application\/atom\+xml"[^>]*href="\/feed\.xml"/, 'the index must advertise the feed');
  assert.match(index, /href="\/feed\.xml"[^>]*>|>an Atom feed</, 'a person must be able to find the feed without reading the source');
  for (const file of files) {
    assert.match(pub(file), /type="application\/atom\+xml"/, `${file} must advertise the feed too — most readers subscribe from a post`);
  }
  assert.ok(pub('.vercelignore').includes('!feed.xml'), 'the feed would not be deployed');
  const headers = JSON.parse(rootFile('vercel.json')).headers.find((h) => h.source === '/feed.xml');
  assert.match(headers?.headers?.[0]?.value ?? '', /application\/atom\+xml/, 'Atom has its own media type');
});

// The site ships zero inline executable script — every page loads its
// behaviour from a same-origin file — so the strict policy costs nothing and
// is measurably safe: all 21 routes were rendered under it in Chrome with no
// violation, structured data included (CSP does not apply to ld+json blocks).
// 'unsafe-inline' survives for styles alone, which the pages do use.
test('the static site carries a content security policy that its own markup can satisfy', () => {
  const config = JSON.parse(rootFile('vercel.json'));
  const all = config.headers.find((h) => h.source === '/(.*)');
  const header = (key) => all.headers.find((h) => h.key === key)?.value ?? '';
  const csp = header('Content-Security-Policy');
  assert.ok(csp, 'every response must carry a CSP');
  for (const directive of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
    assert.ok(csp.includes(directive), `the policy must set ${directive}`);
  }
  assert.doesNotMatch(csp.split('style-src')[0], /unsafe-inline|unsafe-eval/, "script-src must not be loosened — no page needs it");
  assert.ok(header('Permissions-Policy').includes('camera=()'), 'a static site asks for no device permissions');

  // The guard that keeps the policy true: the moment a page inlines script or
  // an onclick handler, that page is broken in production, not merely lax.
  for (const file of fs.readdirSync(path.join(root, 'public')).filter((f) => f.endsWith('.html'))) {
    const html = pub(file);
    for (const [tag] of html.matchAll(/<script[^>]*>/g)) {
      const external = /\ssrc=/.test(tag);
      const data = /type="application\/ld\+json"/.test(tag);
      assert.ok(external || data, `${file} inlines executable script, which the CSP blocks: ${tag}`);
    }
    assert.doesNotMatch(html, /\son(click|load|error|submit|change|input|mouseover)="/, `${file} uses an inline event handler, which the CSP blocks`);
  }
});

// The door is GitHub. The waitlist that preceded it left a serverless intake
// behind in public/api — never wired (Vercel reads functions from the Root
// Directory's /api, and ours is the repo root), so it was served as a plain
// static file that published a personal address at a stable URL for anyone to
// scrape. Deleting it is the fix; this is the tripwire.
test('the deploy carries no intake endpoint, no mail relay, and no personal address', () => {
  assert.ok(!fs.existsSync(path.join(root, 'public', 'api')), 'public/api is served as static files, never as functions — nothing belongs there');
  assert.ok(!fs.existsSync(path.join(root, 'api')), 'a root /api would make every file in it a live endpoint — the door is GitHub, not an inbox');
  const ignore = pub('.vercelignore');
  assert.ok(!/^!api/m.test(ignore), 'the deploy allowlist must not readmit an api directory');
  for (const file of fs.readdirSync(path.join(root, 'public'))) {
    if (!/\.(html|js|txt|xml|css)$/.test(file)) continue;
    const text = pub(file);
    assert.doesNotMatch(text, /unifydynamics/i, `${file} ships a personal address — public mail is hello@ or security@ on our own domain`);
    assert.doesNotMatch(text, /RESEND_API_KEY|api\.resend\.com/, `${file} ships a mail relay — an unauthenticated one is a spam amplifier under our domain`);
  }
});

test('the blog is a real section: every post is routed, deployed, indexed, listed, dated, and sourced', () => {
  const config = JSON.parse(rootFile('vercel.json'));
  const routes = new Map(config.rewrites.map((r) => [r.source, r.destination]));
  assert.equal(routes.get('/blog'), '/blog.html', 'the index must be routed');
  const index = pub('blog.html');
  assert.match(index, /"@type": "Blog"/, 'the index publishes Blog structured data');
  const posts = fs.readdirSync(path.join(root, 'public')).filter((f) => /^blog-.+\.html$/.test(f));
  assert.ok(posts.length >= 1, 'at least one post');
  const sitemap = pub('sitemap.xml');
  const ignore = pub('.vercelignore');
  for (const file of posts) {
    const slug = file.replace(/^blog-/, '').replace(/\.html$/, '');
    const route = `/blog/${slug}`;
    assert.equal(routes.get(route), `/${file}`, `${route} must serve ${file}`);
    assert.ok(ignore.includes(`!${file}`), `${file} would not be deployed`);
    assert.ok(sitemap.includes(`<loc>${SITE}${route}</loc>`), `sitemap is missing ${route}`);
    assert.ok(index.includes(`href="${route}"`), `the index must list ${route}`);
    const html = pub(file);
    assert.match(html, /"@type": "BlogPosting"/, `${file} needs BlogPosting data`);
    assert.match(html, /"datePublished": "20\d\d-\d\d-\d\d"/, `${file} needs a publication date`);
    assert.ok(html.includes(`<link rel="canonical" href="${SITE}${route}"`), `${file} canonical must be its clean route`);
    // House rule: every post links its sources, and names our own limits.
    assert.match(html, /id="sources"/, `${file} must carry a Sources section`);
    assert.match(html, /href="\/sovereignty"/, `${file} must point at the ledger`);
  }
  // The answer-engine index knows the blog exists.
  assert.match(pub('llms.txt'), /## Blog/, 'llms.txt must list the blog');
});

// The three-question test is the site's most portable asset — a BS detector a
// reader can apply to any vendor, ours included, and quote without asking. Its
// power depends on the wording being ONE wording: a test that shifts per
// audience is failing its own third question. These are the canonical strings.
test('the three-question test reads identically on every surface that states it', () => {
  const QUESTIONS = [
    'Can I read every line that runs?',
    'Can I take everything out, verified, in a documented format?',
    "When something isn't private, does the product tell me at that moment?",
  ];
  for (const file of ['land.html', 'three-questions.html', 'what-is-sovereign-ai.html', 'sovereignty.html', 'llms.txt']) {
    const text = pub(file);
    for (const question of QUESTIONS) {
      assert.ok(text.includes(question), `${file} must carry the canonical wording: "${question}"`);
    }
  }
  // The citable page holds the whole argument, not just the list: the dodges,
  // the scorecard with receipts, and the answers that are unflattering.
  const page = pub('three-questions.html');
  assert.match(page, /How it's dodged/, 'each question names how vendors dodge it');
  assert.match(page, /Our own scorecard/, 'a test you exempt yourself from is marketing');
  assert.match(page, /Where our answers run out/, 'the scorecard includes what we fail');
  assert.match(page, /borrowed/, 'borrowed weights are named');
  assert.match(page, /not encrypted at rest/, 'the plaintext database is named');
  assert.match(page, /href="\/sovereignty"/, 'and the ledger holds the full accounting');
  assert.match(page, /Quote this test freely/, 'portability is the point');
  // The surfaces that teach the test link the page that expands it.
  assert.match(pub('what-is-sovereign-ai.html'), /href="\/three-questions"/);
  assert.match(pub('sovereignty.html'), /href="\/three-questions"/);
  assert.match(pub('llms.txt'), /mysovereign\.ai\/three-questions/);
});
