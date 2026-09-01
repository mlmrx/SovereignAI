// The answers engine publishes to the live site on a cadence, from a reviewed
// bank. This file is the review for the machinery: the bank is real questions
// with sourced answers, the rendered page is safe and citable, the wiring is
// idempotent, and the schedule stops rather than pads when the bank runs dry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ANSWERS, BANK_CURATED_AT } from '../src/answers/bank.js';
import { renderAnswerPage, renderProse, toPlain, answerFile, answerRoute, escapeHtml } from '../src/answers/render.js';
import { addRoute, addToIgnore, addToSitemap, addToIndex } from '../src/answers/wire.js';

const root = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// ---------------------------------------------------------------- the bank

test('every answer is a real question with a sourced, reviewable answer', () => {
  const slugs = new Set();
  const internalRoutes = new Set(['/']);
  // Routes the answers may link to: the curated pages plus other answers.
  for (const rule of JSON.parse(read('vercel.json')).rewrites) internalRoutes.add(rule.source);
  for (const a of ANSWERS) internalRoutes.add(answerRoute(a.slug));

  for (const a of ANSWERS) {
    assert.ok(a.slug && /^[a-z0-9-]+$/.test(a.slug), `${a.slug}: slug is url-safe`);
    assert.ok(!slugs.has(a.slug), `duplicate slug ${a.slug}`);
    slugs.add(a.slug);
    assert.ok(a.question?.endsWith('?'), `${a.slug}: the question is a question`);
    assert.ok(a.summary?.length >= 80, `${a.slug}: summary is a real description`);
    assert.ok(a.lead && toPlain(a.lead).length >= 40, `${a.slug}: a direct one-sentence answer`);
    assert.ok(Array.isArray(a.body) && a.body.length >= 1, `${a.slug}: a body`);
    assert.equal(typeof a.reviewed, 'boolean', `${a.slug}: reviewed is an explicit gate`);
    assert.match(a.written, /^\d{4}-\d{2}-\d{2}$/, `${a.slug}: a written date`);
    assert.ok(a.keywords?.length > 10, `${a.slug}: keywords for discovery`);
    assert.ok(Array.isArray(a.related) && a.related.length >= 1, `${a.slug}: links to read further`);

    // Every internal link in the prose and the related list resolves to a real
    // route — an answer that links a 404 fails its own promise to be sourced.
    const links = [...`${a.lead} ${a.body.join(' ')}`.matchAll(/\]\((\/[A-Za-z0-9/_-]*)\)/g)].map((m) => m[1]);
    for (const [href] of a.related) links.push(href);
    for (const href of links) {
      if (href.startsWith('http')) continue;
      assert.ok(internalRoutes.has(href), `${a.slug}: links ${href}, which no route serves`);
    }
    // External sources are https and carry a label.
    for (const [href, label] of a.sources ?? []) {
      assert.match(href, /^https:\/\//, `${a.slug}: a source must be a real URL`);
      assert.ok(label?.length > 2, `${a.slug}: a source needs a label`);
    }
  }
  assert.match(BANK_CURATED_AT, /^\d{4}-\d{2}$/, 'the bank is dated');
  assert.ok(ANSWERS.some((a) => a.reviewed), 'at least one answer is ready to publish');
});

test('answers are honest: the ones about our own product state a limit somewhere', () => {
  // A whole library that only ever flatters us is marketing wearing a Q&A hat.
  const corpus = ANSWERS.map((a) => toPlain([a.lead, ...a.body].join(' '))).join(' ').toLowerCase();
  assert.ok(
    /not encrypted at rest|borrowed|someone else'?s artifact|not yet|honest caveat|linux x86_64 with an nvidia|depends on the model/.test(corpus),
    'the library must name real limits, not only wins'
  );
  // And it must not concede the model layer in the competitor's framing.
  assert.doesNotMatch(corpus, /rent the intelligence/i);
});

// ---------------------------------------------------------------- rendering

test('the rendered answer page is safe, citable, and shell-framed', () => {
  const page = renderAnswerPage(ANSWERS[0]);
  const a = ANSWERS[0];

  // Structured for extraction: a QAPage with the question and an accepted answer.
  const ld = JSON.parse(page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(ld['@type'], 'QAPage');
  assert.equal(ld.mainEntity['@type'], 'Question');
  assert.equal(ld.mainEntity.acceptedAnswer['@type'], 'Answer');
  assert.ok(ld.mainEntity.acceptedAnswer.text.length > 100, 'the answer text is the real answer');
  assert.ok(!/[[\]]|\*\*/.test(ld.mainEntity.acceptedAnswer.text), 'the JSON answer is plain, not markup');

  assert.match(page, new RegExp(`<link rel="canonical" href="https://mysovereign\\.ai${answerRoute(a.slug)}"`));
  assert.match(page, /<meta name="description" content="[^"]{80,}"/, 'a substantial description');
  assert.match(page, /<h1 class="serif">/, 'the question is the h1');
  assert.match(page, /class="a-lead"/, 'the direct answer leads');
  assert.match(page, /Read further/, 'related links are shown to people, not only crawlers');

  // Shell-framed like every other page.
  assert.match(page, /<header class="shell-bar">/);
  assert.match(page, /<footer class="shell-foot">/);
  assert.match(page, /data-theme-mount/);
  assert.match(page, /href="\/three-questions"/, 'and points at the test we hold ourselves to');

  // CSP-safe: no inline script, no inline handlers.
  for (const [tag] of page.matchAll(/<script[^>]*>/g)) {
    assert.ok(/\ssrc=/.test(tag) || /application\/ld\+json/.test(tag), `inline script would be blocked: ${tag}`);
  }
  assert.doesNotMatch(page, /\son(click|load|error|submit)=/);
});

test('prose markup is applied only after escaping, so no answer can inject HTML', () => {
  // A hostile answer (there are none, but the renderer must not depend on that).
  const nasty = 'Break <img src=x onerror=alert(1)> out, **bold**, and a [link](/sovereignty) and [evil](javascript:alert(1)).';
  const out = renderProse(nasty);
  // "onerror=" surviving as text inside an escaped string is harmless — what
  // must never appear is an angle bracket that opens a tag.
  assert.doesNotMatch(out, /<img\b/i, 'no image tag can be conjured from the text');
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/, 'it shows as text');
  assert.match(out, /<strong>bold<\/strong>/, 'bold works');
  assert.match(out, /<a href="\/sovereignty">link<\/a>/, 'an internal link works');
  assert.doesNotMatch(out, /href="javascript:/, 'a non-http, non-path link is left as text, not made clickable');
  // toPlain strips markup for the JSON body.
  assert.equal(toPlain('a **b** [c](/x) d'), 'a b c d');
  assert.equal(escapeHtml('<&">'), '&lt;&amp;&quot;&gt;');
});

// ---------------------------------------------------------------- wiring

test('wiring an answer is idempotent in all four places', () => {
  const slug = 'test-answer-slug';
  const route = answerRoute(slug);
  const file = answerFile(slug);

  const vercel = addRoute(read('vercel.json'), route, file);
  assert.match(vercel, /"source": "\/answers\/test-answer-slug"/);
  assert.equal(addRoute(vercel, route, file), vercel, 'twice is a no-op');
  assert.equal(JSON.parse(vercel).rewrites.filter((r) => r.source === route).length, 1);

  const ignore = addToIgnore(read('public/.vercelignore'), file);
  assert.ok(ignore.includes(`!${file}`));
  assert.equal(addToIgnore(ignore, file), ignore);

  const sitemap = addToSitemap(read('public/sitemap.xml'), route, '2026-09-01');
  assert.ok(sitemap.includes(`<loc>https://mysovereign.ai${route}</loc>`));
  assert.ok(sitemap.trimEnd().endsWith('</urlset>'), 'the document stays well-formed');
  assert.equal(addToSitemap(sitemap, route, '2026-09-01'), sitemap);

  const index = addToIndex(read('public/answers.html'), { route, question: 'A test question?', date: '2026-09-01' });
  assert.ok(index.includes(`href="${route}"`), 'an unlinked answer is an orphan');
  assert.equal(addToIndex(index, { route, question: 'A test question?', date: '2026-09-01' }), index);
  // Newest first: a later answer sits above this one.
  const two = addToIndex(index, { route: answerRoute('later'), question: 'Later?', date: '2026-09-02' });
  assert.ok(two.indexOf(answerRoute('later')) < two.indexOf(route));

  assert.throws(() => addToIndex('<html></html>', { route, question: 'q?', date: 'd' }), /list marker/);
  assert.throws(() => addToIgnore('nothing familiar', file), /robots\.txt anchor/);
});

// ---------------------------------------------------------------- the engine

test('the publish engine and its workflow publish reviewed answers, then stop rather than pad', () => {
  const script = read('scripts/answers-publish.js');
  assert.match(script, /--dry-run/, 'runnable without writing');
  assert.match(script, /a\.reviewed && !published/, 'only reviewed, only not-yet-published');
  assert.match(script, /reviewed answer bank is empty/, 'an empty bank is a real, named state');
  assert.match(script, /process\.env\.GITHUB_OUTPUT/, 'the verdict is handed to the workflow directly');
  assert.doesNotMatch(script, /require\('\.\.\/src\/answers\/bank/, 'ES modules, like the rest of the codebase');

  const wf = read('.github/workflows/answers.yml');
  assert.match(wf, /schedule:/, 'it runs on a cadence');
  assert.match(wf, /workflow_dispatch:/, 'and can be run by hand');
  assert.match(wf, /vars\.ANSWERS_ENABLED/, 'a repository variable can stop it without a commit');
  assert.match(wf, /npm test/, 'nothing is committed that has not passed the whole suite');
  assert.match(wf, /bank is empty/i, 'a dry bank asks for more instead of fabricating');
  // The deploy lesson from the watchtower: pushing deploys, so no deploy step.
  assert.doesNotMatch(wf, /vercel.*deploy --prod/, 'a deploy step would double-deploy the auto-deploying project');
  for (const line of wf.split('\n')) {
    if (/^\s*if:/.test(line)) assert.doesNotMatch(line, /secrets\./, 'secrets is not a context a step-level if can read');
  }
});

test('the answers section is discoverable: index page, footer link, llms, sitemap', () => {
  const index = read('public/answers.html');
  assert.match(index, /<!-- answers:list -->/, 'the list has a stable insertion marker');
  assert.match(index, /"@type": "CollectionPage"/, 'the index publishes structured data');

  // Linked from every marketing footer, so a crawler reaches the whole library.
  // The app surfaces (command center, playground interfaces) carry no
  // shell-foot marketing footer and are excluded — they are not crawl doors.
  for (const file of fs.readdirSync(path.join(root, 'public')).filter((f) => f.endsWith('.html'))) {
    const foot = read(`public/${file}`).match(/<footer class="shell-foot">([\s\S]*?)<\/footer>/)?.[1];
    if (!foot) continue;
    assert.match(foot, /href="\/answers"/, `${file} footer must reach the answers library`);
  }
  // And introduced to answer engines and crawlers.
  assert.match(read('public/llms.txt'), /## Answers/);
  assert.match(read('public/sitemap.xml'), /<loc>https:\/\/mysovereign\.ai\/answers<\/loc>/);
  // The future watchtower digests carry the footer link too.
  assert.match(read('src/watchtower/render.js'), /href="\/answers"/);
});
