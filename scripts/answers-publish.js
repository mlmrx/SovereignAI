#!/usr/bin/env node
/**
 * Publish the next reviewed answer(s) from the bank.
 *
 * Run on a cadence by .github/workflows/answers.yml. This does the reading and
 * the file work only; committing and deploying belong to the workflow (the
 * Vercel project auto-deploys on push), so everything here is exercisable with
 * --dry-run on a laptop.
 *
 *   node scripts/answers-publish.js --dry-run        show what would publish
 *   node scripts/answers-publish.js                  publish the next one
 *   node scripts/answers-publish.js --count=3        publish the next three
 *   node scripts/answers-publish.js --all            publish every remaining
 *
 * It publishes REVIEWED answers only, in bank order, one page each. When the
 * reviewed bank is exhausted it publishes nothing and asks for more — the
 * honest version of "publish daily": real content until it runs out, never
 * filler to hit a number. A page that fails the test suite is caught by the
 * workflow before anything is committed, so a bad answer never reaches the
 * site.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ANSWERS } from '../src/answers/bank.js';
import { renderAnswerPage, answerFile, answerRoute } from '../src/answers/render.js';
import { addRoute, addToIgnore, addToSitemap, addToIndex } from '../src/answers/wire.js';

const root = path.resolve(import.meta.dirname, '..');
const rd = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const wr = (f, s) => fs.writeFileSync(path.join(root, f), s);

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const all = argv.includes('--all');
const count = all ? Infinity : Number(argv.find((a) => a.startsWith('--count='))?.split('=')[1] ?? 1);

const published = (slug) => fs.existsSync(path.join(root, 'public', answerFile(slug)));

/** The reviewed answers not yet on disk, in bank (priority) order. */
function pending() {
  return ANSWERS.filter((a) => a.reviewed && !published(a.slug));
}

function publishOne(answer) {
  const file = answerFile(answer.slug);
  const route = answerRoute(answer.slug);
  wr(`public/${file}`, renderAnswerPage(answer));
  wr('vercel.json', addRoute(rd('vercel.json'), route, file));
  wr('public/.vercelignore', addToIgnore(rd('public/.vercelignore'), file));
  wr('public/sitemap.xml', addToSitemap(rd('public/sitemap.xml'), route, answer.written));
  wr('public/answers.html', addToIndex(rd('public/answers.html'), { route, question: answer.question, date: answer.written }));
}

function main() {
  const queue = pending();
  const reviewed = ANSWERS.filter((a) => a.reviewed).length;
  const drafts = ANSWERS.length - reviewed;
  console.log(`bank: ${ANSWERS.length} total, ${reviewed} reviewed, ${drafts} draft(s); ${queue.length} not yet published.`);

  const take = queue.slice(0, count === Infinity ? queue.length : Math.max(0, count));
  const result = { published: take.length > 0, count: 0, slugs: [], remaining: queue.length, bankEmpty: queue.length === 0 };

  if (queue.length === 0) {
    console.log('The reviewed answer bank is empty. Nothing to publish — add reviewed answers to src/answers/bank.js.');
  } else if (dryRun) {
    for (const a of take) console.log(`  would publish  ${answerRoute(a.slug)}  —  ${a.question}`);
  } else {
    for (const a of take) {
      publishOne(a);
      result.count++;
      result.slugs.push(a.slug);
      console.log(`  published  ${answerRoute(a.slug)}`);
    }
    result.remaining = queue.length - result.count;
    result.published = result.count > 0;
  }

  // Hand the verdict straight to the workflow — never re-read a file that a
  // previous run may have written (the mistake the watchtower taught us).
  if (process.env.GITHUB_OUTPUT) {
    const issue = result.remaining === 0; // ask for more only once the bank is dry
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `published=${result.published}\ncount=${result.count}\nremaining=${result.remaining}\nbank_empty=${issue}\n`
    );
  }
  return result;
}

main();
