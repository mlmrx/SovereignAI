// The watchtower publishes to the live site with nobody reading it first.
// That makes this file the review: everything a human editor would otherwise
// catch has to be caught here instead — a feed that lies, a headline that is
// markup, a chatty repository drowning fifteen quiet ones, a slow week padded
// into a post, and the standing question of whether a link on our blog reads
// as a recommendation we did not mean to make.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { clean, safeUrl, isoDate, parseFeed, parseHuggingFace, parseSource, summarize } from '../src/watchtower/feeds.js';
import { SOURCES, CATEGORIES, SOURCES_CURATED_AT, isRelevant, isPublishable, perSourceLimit, NEVER_PUBLISH } from '../src/watchtower/sources.js';
import { selectItems, buildDigest, nextSeen, issueBody, FRESH_DAYS, REMEMBER_DAYS } from '../src/watchtower/digest.js';
import { checkStaleness, checkVersionDrift } from '../src/watchtower/staleness.js';
import { renderDigestPage, digestFile, digestRoute, digestSlug, digestDescription, escapeHtml } from '../src/watchtower/render.js';
import { addRewrite, addToIgnore, addToSitemap, addToIndex, addToLlms, ensureIndexStyles } from '../src/watchtower/wire.js';

const root = path.resolve(import.meta.dirname, '..');
const DAY = 86_400_000;
const NOW = Date.parse('2026-09-07T00:00:00Z');
const src = (id, category = 'engines') => ({ id, label: id, category });
const workflowText = () => fs.readFileSync(path.join(root, '.github', 'workflows', 'watchtower.yml'), 'utf8');
const item = (over = {}) => ({ title: 'A release', url: `https://example.com/${Math.random()}`, date: '2026-09-06', summary: '', ...over });

// ---------------------------------------------------------------- parsing

test('Atom and RSS both yield the four fields the digest needs', () => {
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
    <entry><title>v0.33.2</title><link rel="alternate" href="https://github.com/ollama/ollama/releases/tag/v0.33.2"/>
      <updated>2026-08-28T10:00:00Z</updated><content type="html">Fixes &amp; things</content></entry>
  </feed>`;
  assert.deepEqual(parseFeed(atom), [
    { title: 'v0.33.2', url: 'https://github.com/ollama/ollama/releases/tag/v0.33.2', date: '2026-08-28', summary: '' },
  ]);

  const rss = `<rss><channel><item>
    <title><![CDATA[Granite 4.2 LLMs: How They're Built]]></title>
    <link>https://huggingface.co/blog/granite</link>
    <pubDate>Fri, 28 Aug 2026 09:00:00 GMT</pubDate>
    <description>A long enough description to survive the summary floor, about models.</description>
  </item></channel></rss>`;
  const [post] = parseFeed(rss);
  assert.equal(post.title, "Granite 4.2 LLMs: How They're Built", 'CDATA and entities are decoded once');
  assert.equal(post.date, '2026-08-28');
  assert.match(post.summary, /^A long enough description/);
});

test('an item the parser cannot trust is dropped, never guessed at', () => {
  const bad = `<feed>
    <entry><title>No link at all</title><updated>2026-09-01</updated></entry>
    <entry><link href="https://example.com/x"/><updated>2026-09-01</updated></entry>
    <entry><title>Not a web link</title><link href="javascript:alert(1)"/></entry>
    <entry><title>Nor this one</title><link href="file:///etc/passwd"/></entry>
    <entry><title>Good</title><link href="https://example.com/good"/></entry>
  </feed>`;
  assert.deepEqual(parseFeed(bad).map((i) => i.title), ['Good'], 'a title without a link, a link without a title, and non-http schemes all go');
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('data:text/html,<script>'), null);
  assert.equal(safeUrl('not a url'), null);
  assert.equal(isoDate('nonsense'), null);
  assert.equal(isoDate(''), null);
  assert.deepEqual(parseFeed(''), []);
  assert.deepEqual(parseSource('unknown-kind', '<feed/>'), []);
});

test('every published string is defanged: no markup, no control characters, bounded', () => {
  const nasty = 'Title <script>alert(1)</script> with <b>markup</b>';
  assert.equal(clean(nasty), 'Title alert(1) with markup', 'tags are stripped rather than escaped-and-kept');
  assert.equal(clean(`a${String.fromCharCode(7)}b`), 'a b', 'control characters never reach a page or a commit message');
  assert.equal(clean('&amp;lt;script&amp;gt;'), '&lt;script&gt;', 'entities decode exactly once — "&amp;lt;" must not become "<"');
  const long = clean('word '.repeat(200), 50);
  assert.ok(long.length <= 51 && long.endsWith('…'), 'long values are cut on a word boundary and marked');

  // A headline is a stranger's input and ends up inside HTML.
  const page = renderDigestPage(buildDigest({
    fetched: [{ source: src('evil'), items: [item({ title: 'Pwn <img src=x onerror=alert(1)>', url: 'https://example.com/a', summary: '"><script>alert(2)</script>' })] }],
    now: NOW,
  }));
  // The invariant is that no feed value becomes a TAG. The characters
  // "onerror=" surviving as text inside an escaped string is harmless and
  // expected — what must never appear is an angle bracket that opens one.
  const body = page.slice(page.indexOf('</style>'));
  assert.doesNotMatch(body, /<img\b/i, 'no image tag can be conjured from a headline');
  assert.doesNotMatch(body, /<script[^>]*>\s*alert/i, 'nor a script');
  assert.match(page, /&lt;img src=x onerror=alert\(1\)&gt;/, 'it is shown as text instead');
  assert.match(page, /&quot;&gt;&lt;script&gt;alert\(2\)&lt;\/script&gt;/, 'and so is a summary that tries to break out of an attribute');
});

test('release-note noise is stripped from summaries, and a fragment is no summary at all', () => {
  const notes = 'sycl: split long rows in TOP_K ( #27847 ) Website: https://llama.app Attestations: https://github.com/ggml-org/llama.cpp/attestations/43958406 Co-authored-by: Someone <a@b.c>';
  const out = summarize(notes);
  assert.doesNotMatch(out, /https?:\/\//, 'the link is already on the headline');
  assert.doesNotMatch(out, /Co-authored-by/i);
  assert.doesNotMatch(out, /#27847/, 'PR numbers mean nothing to a reader here');
  assert.equal(summarize('tiny'), '', 'too thin to be a sentence is published as nothing');
  assert.equal(summarize('  '), '');
});

test('the Hugging Face API becomes items, and anything not a model id is skipped', () => {
  const rows = JSON.stringify([
    { id: 'Qwen/Qwen3.8-Flash-Next', createdAt: '2026-08-29T00:00:00Z', downloads: 12345, likes: 67, tags: ['gguf', 'text-generation', 'unrelated'] },
    { id: 'not-a-model-id', createdAt: '2026-08-29T00:00:00Z' },
    { nonsense: true },
  ]);
  const [model, ...rest] = parseHuggingFace(rows);
  assert.equal(rest.length, 0, 'a bare name is not an org/model id');
  assert.equal(model.title, 'Qwen/Qwen3.8-Flash-Next');
  assert.equal(model.url, 'https://huggingface.co/Qwen/Qwen3.8-Flash-Next');
  assert.equal(model.summary, '12,345 downloads · 67 likes · gguf · text-generation');
  assert.deepEqual(parseHuggingFace('not json'), []);
  assert.deepEqual(parseHuggingFace('{"not":"an array"}'), []);
});

// ---------------------------------------------------------------- selection

test('relevance takes one strong signal or two weak ones — the lesson of two bad items', () => {
  // Both of these actually reached a rendered page before the filter was fixed.
  const gamescom = { title: 'GeForce NOW Gives Gamers More Ways to Play at Gamescom 2026', summary: 'New ways to play, more devices, and DLSS 4.5 fine-tuning for the cloud.' };
  assert.equal(isRelevant('nvidia-blog', gamescom), false, 'one weak substring is not evidence of anything');
  assert.equal(isRelevant('nvidia-blog', { title: 'NVIDIA Extends Vera Rubin Inference Platform', summary: '' }), true, 'one strong term is enough');
  assert.equal(isRelevant('nvidia-blog', { title: 'Training and Finetuning Multi-Vector Embedding Models', summary: '' }), true, 'two weak terms together are');
  // A source that is already about exactly one thing is not filtered at all.
  assert.equal(isRelevant('ollama', { title: 'v0.33.2', summary: '' }), true);
});

test('build artifacts are not news: a source may declare what to skip', () => {
  assert.equal(isRelevant('llama-cpp', { title: 'b10694', summary: '' }), false, 'ten CI builds a day filled six of eight slots on the first run');
  assert.equal(isRelevant('llama-cpp', { title: 'v1.2.0 — named release', summary: '' }), true);
  assert.equal(isRelevant('jan', { title: 'checkpoint/code-ui-subagent-20260723', summary: '' }), false);
  assert.equal(isRelevant('jan', { title: '0.8.4', summary: '' }), true);
});

test('a link on our blog reads as a recommendation, so some titles are never published unattended', () => {
  for (const term of NEVER_PUBLISH) {
    assert.equal(isPublishable({ title: `someone/Model-${term}-GGUF` }), false, `${term} must not auto-publish`);
  }
  assert.equal(isPublishable({ title: 'Qwen/Qwen3.8-Flash-Next' }), true);
  assert.equal(isPublishable({ title: 'UNCENSORED-model' }), false, 'the check is case-insensitive');
});

test('one chatty source cannot crowd out fifteen quiet ones', () => {
  const many = Array.from({ length: 10 }, (_, i) => item({ title: `r${i}`, url: `https://example.com/r${i}`, date: '2026-09-06' }));
  const chosen = selectItems({ fetched: [{ source: src('ollama'), items: many }], now: NOW });
  assert.equal(chosen.length, perSourceLimit('ollama'), 'the default per-source cap applies');
  assert.equal(perSourceLimit('llama-cpp'), 1, 'a build-log source is capped tighter still');
  assert.equal(perSourceLimit('unknown-source'), 2, 'the default covers a source that declares nothing');
  // Capping happens after sorting, so a source keeps its NEWEST items.
  const mixed = selectItems({
    fetched: [{ source: src('ollama'), items: [item({ title: 'old', url: 'https://e.com/1', date: '2026-08-20' }), item({ title: 'new', url: 'https://e.com/2', date: '2026-09-06' }), item({ title: 'newest', url: 'https://e.com/3', date: '2026-09-07' })] }],
    now: NOW,
  });
  assert.deepEqual(mixed.map((i) => i.title), ['newest', 'new']);
});

test('nothing is published twice, and a feed exposing its history is not a week of news', () => {
  const fetched = [{ source: src('ollama'), items: [
    item({ title: 'seen already', url: 'https://example.com/seen' }),
    item({ title: 'ancient', url: 'https://example.com/old', date: '2020-01-01' }),
    item({ title: 'fresh', url: 'https://example.com/fresh', date: '2026-09-06' }),
  ] }];
  const chosen = selectItems({ fetched, seen: { 'https://example.com/seen': '2026-08-01' }, now: NOW });
  assert.deepEqual(chosen.map((i) => i.title), ['fresh']);

  // The same URL from two sources is one item.
  const dup = selectItems({
    fetched: [{ source: src('a'), items: [item({ url: 'https://same/x' })] }, { source: src('b'), items: [item({ url: 'https://same/x' })] }],
    now: NOW,
  });
  assert.equal(dup.length, 1);

  // An item with no date is kept: some feeds simply omit one.
  const undated = selectItems({ fetched: [{ source: src('a'), items: [item({ date: null })] }], now: NOW });
  assert.equal(undated.length, 1);
  assert.ok(FRESH_DAYS > 0 && REMEMBER_DAYS > FRESH_DAYS, 'we remember for longer than we consider fresh, or items would return');
});

// ---------------------------------------------------------------- the digest

test('a quiet week publishes nothing, and staleness alone is never a reason to post', () => {
  const empty = buildDigest({ fetched: [{ source: src('ollama'), items: [] }], now: NOW, staleness: [{ id: 'shelf', severity: 'alarm', message: 'stale' }] });
  assert.equal(empty.worthPublishing, false, 'there is no pressure to manufacture a week');
  assert.equal(empty.categories.length, 0);
  assert.match(issueBody(empty), /Nothing new in any watched source/);
  assert.match(issueBody(empty), /## Staleness/, 'the chore still reaches the issue');
});

test('security never rides along in a blog post — it goes to the issue, immediately', () => {
  const digest = buildDigest({
    fetched: [
      { source: src('node-security', 'security'), items: [item({ title: 'CVE-2026-1234 in Node 22', url: 'https://nodejs.org/a' })] },
      { source: src('ollama'), items: [item({ title: 'v1', url: 'https://e.com/v1' })] },
    ],
    now: NOW,
  });
  assert.equal(digest.security.length, 1);
  assert.ok(!digest.categories.some((c) => c.id === 'security'), 'no security section is ever rendered on the page');
  const page = renderDigestPage(digest);
  assert.doesNotMatch(page, /CVE-2026-1234/, 'an advisory must not wait a week behind a publishing decision');
  assert.match(issueBody(digest), /## Security — read first/);
  assert.match(issueBody(digest), /CVE-2026-1234/);
});

test('the seen record grows with everything offered and forgets what is old', () => {
  const fetched = [{ source: src('a'), items: [item({ url: 'https://e.com/new' })] }];
  const next = nextSeen({ seen: { 'https://e.com/ancient': '2020-01-01', 'https://e.com/recent': '2026-09-01' }, fetched, now: NOW });
  assert.ok(!('https://e.com/ancient' in next), 'the file cannot grow forever');
  assert.equal(next['https://e.com/recent'], '2026-09-01', 'a remembered URL keeps its ORIGINAL date, not today');
  assert.equal(next['https://e.com/new'], '2026-09-07');
  // Held-back items are remembered too, or every digest repeats the last one.
  const held = Array.from({ length: 9 }, (_, i) => item({ url: `https://e.com/h${i}` }));
  assert.equal(Object.keys(nextSeen({ seen: {}, fetched: [{ source: src('a'), items: held }], now: NOW })).length, 9);
});

// ---------------------------------------------------------------- ourselves

test('staleness warns about our own dated claims, and escalates', () => {
  const base = { shelfCuratedAt: '2026-08', sourcesCuratedAt: '2026-08', posts: [{ date: '2026-08-25' }] };
  assert.deepEqual(checkStaleness({ ...base, now: Date.parse('2026-09-07') }), [], 'a fresh shelf and a recent post say nothing');

  const threeMonths = checkStaleness({ ...base, now: Date.parse('2026-11-20') });
  assert.equal(threeMonths.find((n) => n.id === 'shelf')?.severity, 'warn');
  assert.equal(threeMonths.find((n) => n.id === 'blog')?.severity, 'alarm', 'two months of silence while digests run is worse than no digests');

  const halfYear = checkStaleness({ ...base, now: Date.parse('2027-03-01') });
  assert.equal(halfYear.find((n) => n.id === 'shelf')?.severity, 'alarm');
  assert.match(halfYear.find((n) => n.id === 'shelf').message, /advice about a landscape that has moved/);

  // A machine posting links does not discharge the promise of a written post.
  const digestsOnly = checkStaleness({ shelfCuratedAt: '2026-08', sourcesCuratedAt: '2026-08', posts: [{ date: '2026-08-25' }, { date: '2026-11-01', digest: true }], now: Date.parse('2026-11-05') });
  assert.ok(digestsOnly.some((n) => n.id === 'blog'), 'weekly digests must not silence the monthly-post warning');
});

test('a version claim ahead of the shipping version is a promise not yet kept', () => {
  const notes = checkVersionDrift({ version: '0.6.0', files: [{ path: 'public/guide.html', text: 'ships in v0.7.1' }, { path: 'README.md', text: 'v0.6.0 is current' }] });
  assert.equal(notes.length, 1);
  assert.match(notes[0].message, /public\/guide\.html names v0\.7\.1/);
  assert.equal(checkVersionDrift({ version: '0.6.0', files: [{ path: 'a', text: 'v0.5.0 was before' }] }).length, 0);
});

// ---------------------------------------------------------------- the page

test('the published page keeps every house rule a written post must keep', () => {
  const digest = buildDigest({
    fetched: [{ source: { id: 'ollama', label: 'Ollama', category: 'engines' }, items: [item({ title: 'v0.33.2', url: 'https://github.com/ollama/ollama/releases/tag/v0.33.2', summary: 'A summary long enough to be worth showing to somebody.' })] }],
    now: NOW,
  });
  const page = renderDigestPage(digest);
  assert.equal(digestSlug('2026-09-07'), 'signals-2026-09-07');
  assert.equal(digestFile('2026-09-07'), 'blog-signals-2026-09-07.html');
  assert.equal(digestRoute('2026-09-07'), '/blog/signals-2026-09-07');

  assert.match(page, /"@type": "BlogPosting"/);
  assert.match(page, /"datePublished": "2026-09-07"/);
  assert.match(page, /<link rel="canonical" href="https:\/\/mysovereign\.ai\/blog\/signals-2026-09-07"/);
  assert.match(page, /id="sources"/, 'the house rule: every post links its sources');
  assert.match(page, /href="\/sovereignty"/, 'and points at our own limits');
  assert.match(page, /type="application\/atom\+xml"/);
  assert.ok(digestDescription(digest).length >= 80, 'a description a reader can judge from');

  // The CSP forbids inline script; a page that breaks it is broken in production.
  for (const [tag] of page.matchAll(/<script[^>]*>/g)) {
    assert.ok(/\ssrc=/.test(tag) || /application\/ld\+json/.test(tag), `inline script would be blocked: ${tag}`);
  }
  assert.doesNotMatch(page, /\son(click|load|error)=/);

  // It says what it is, in the first screen, without being asked.
  assert.match(page, /Assembled automatically from primary sources/);
  assert.match(page, /no editor read this before it went up/);
  assert.match(page, /Inclusion is not endorsement/);
  assert.match(page, /counts nothing/, 'the standard footer travels with it');
});

test('the digest makes no claim about our own product', () => {
  const page = renderDigestPage(buildDigest({ fetched: [{ source: src('ollama'), items: [item({ title: 'v1', url: 'https://e.com/1' })] }], now: NOW }));
  const prose = page.slice(page.indexOf('<main>'));
  // The whole safety argument rests on this: the machine reports what OTHERS
  // shipped. The moment it describes what WE shipped, nobody is checking it.
  for (const claim of [/\bwe (now )?(support|ship|added|built|released)\b/i, /SovereignAI (now )?(supports|ships|adds|can)\b/i, /\bour new\b/i]) {
    assert.doesNotMatch(prose, claim, `the digest must not describe our own product: ${claim}`);
  }
});

// ---------------------------------------------------------------- wiring

test('wiring a post is idempotent in all seven places', () => {
  const route = '/blog/signals-2026-09-07';
  const file = 'blog-signals-2026-09-07.html';
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

  const vercel = addRewrite(read('vercel.json'), route, file);
  assert.match(vercel, /"source": "\/blog\/signals-2026-09-07"/);
  assert.equal(addRewrite(vercel, route, file), vercel, 'wiring twice is a no-op, not a duplicate');
  assert.equal(JSON.parse(vercel).rewrites.filter((r) => r.source === route).length, 1);

  const ignore = addToIgnore(read('public/.vercelignore'), file);
  assert.ok(ignore.includes(`!${file}`));
  assert.equal(addToIgnore(ignore, file), ignore);

  const sitemap = addToSitemap(read('public/sitemap.xml'), route, '2026-09-07');
  assert.ok(sitemap.includes(`<loc>https://mysovereign.ai${route}</loc>`));
  assert.ok(sitemap.trimEnd().endsWith('</urlset>'), 'the document stays well-formed');
  assert.equal(addToSitemap(sitemap, route, '2026-09-07'), sitemap);

  const index = addToIndex(ensureIndexStyles(read('public/blog.html')), { route, date: '2026-09-07', count: 12 });
  assert.ok(index.includes(`href="${route}"`), 'an unlinked page is an orphan no crawler reaches');
  assert.equal(addToIndex(index, { route, date: '2026-09-07', count: 12 }), index);
  assert.equal(ensureIndexStyles(index), index, 'the styles land exactly once');
  // Newest first: a second, later digest sits above the first.
  const two = addToIndex(index, { route: '/blog/signals-2026-09-14', date: '2026-09-14', count: 5 });
  assert.ok(two.indexOf('signals-2026-09-14') < two.indexOf('signals-2026-09-07'));

  const llms = addToLlms(read('public/llms.txt'), { route, date: '2026-09-07', count: 12 });
  assert.ok(llms.includes(`https://mysovereign.ai${route}`));
  // llms.txt names the LATEST digest rather than growing a list nobody reads.
  const later = addToLlms(llms, { route: '/blog/signals-2026-09-14', date: '2026-09-14', count: 5 });
  assert.ok(later.includes('signals-2026-09-14') && !later.includes('signals-2026-09-07'));
});

test('the wiring refuses to guess when the file it edits has changed shape', () => {
  assert.throws(() => addToIgnore('nothing familiar here', 'x.html'), /robots\.txt anchor/);
  assert.throws(() => addToIndex('<html></html>', { route: '/a', date: '2026-09-07', count: 1 }), /house-rules block/);
  assert.throws(() => addToLlms('nothing familiar', { route: '/a', date: '2026-09-07', count: 1 }), /feed anchor/);
  assert.throws(() => ensureIndexStyles('<html></html>'), /house style anchor/);
});

// ---------------------------------------------------------------- the config

test('every source is a primary, keyless, categorized feed with a stated reason', () => {
  const ids = new Set();
  for (const source of SOURCES) {
    assert.ok(!ids.has(source.id), `duplicate source id ${source.id}`);
    ids.add(source.id);
    assert.ok(['atom', 'rss', 'huggingface'].includes(source.kind), `${source.id}: kind`);
    assert.ok(CATEGORIES.some((c) => c.id === source.category), `${source.id}: category must exist`);
    assert.match(source.url, /^https:\/\//, `${source.id}: https only`);
    assert.ok(source.why && source.why.length > 30, `${source.id}: say why it is watched`);
    assert.doesNotMatch(source.url, /[?&](token|key|api_key)=/i, `${source.id}: a source needing a key is not keyless`);
    if (source.skip) assert.doesNotThrow(() => new RegExp(source.skip), `${source.id}: skip must compile`);
  }
  assert.match(SOURCES_CURATED_AT, /^\d{4}-\d{2}$/, 'the opinion carries a date so it can look stale');
  assert.ok(SOURCES.some((s) => s.category === 'security'), 'something must watch for advisories');
  assert.ok(escapeHtml('<&">') === '&lt;&amp;&quot;&gt;');
});

test('the runner exists, publishes only when there is something to publish, and can be stopped', () => {
  const runner = fs.readFileSync(path.join(root, 'scripts', 'watchtower.js'), 'utf8');
  assert.match(runner, /--dry-run/, 'it must be runnable without publishing');
  assert.match(runner, /worthPublishing/, 'a quiet week is allowed to be quiet');
  // The gate must be driven by THIS run. The first CI dry run read a
  // committed report, saw published:true from a previous run, and walked
  // into the commit step with nothing to commit.
  assert.match(runner, /process\.env\.GITHUB_OUTPUT/, 'the verdict is handed to the workflow directly');
  assert.match(runner, /published=\$\{result\.published\}/, 'and it is this run’s verdict');
  assert.doesNotMatch(workflowText(), /require\('\.\/watchtower\/last-run\.json'\)\.published/, 'the gate must not re-read a file that may be stale');
  const workflow = workflowText();
  assert.match(workflow, /schedule:/, 'it runs on a cadence');
  assert.match(workflow, /workflow_dispatch:/, 'and can be run by hand');
  assert.match(workflow, /vars\.WATCHTOWER_ENABLED/, 'a repository variable can stop it without a commit');
  assert.match(workflow, /npm test/, 'nothing is committed that has not passed the whole suite');
});
