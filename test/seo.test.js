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
