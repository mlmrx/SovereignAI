#!/usr/bin/env node
/**
 * The watchtower: read the primary sources, publish a digest, flag what has
 * gone stale.
 *
 * Run weekly by .github/workflows/watchtower.yml. This script does the reading
 * and the file work only — committing, opening the issue, and deploying belong
 * to the workflow, so everything here can be exercised with --dry-run on a
 * laptop and the risky verbs stay in one visible place.
 *
 *   node scripts/watchtower.js --dry-run    read everything, write nothing
 *   node scripts/watchtower.js              publish if there is anything new
 *   node scripts/watchtower.js --offline    use the cached fetch, for tests
 *
 * It publishes automatically. Four things make that defensible, and all four
 * are load-bearing:
 *   1. It is a formatter, not an author — every line is a publisher's own
 *      headline, date and link (src/watchtower/digest.js).
 *   2. It makes no claim about our own product anywhere on the page.
 *   3. It publishes nothing when nothing is new, so there is no pressure to
 *      manufacture a week.
 *   4. The full test suite runs against the wired site before the workflow is
 *      allowed to commit; a post that breaks a house rule never lands.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SOURCES, SOURCES_CURATED_AT } from '../src/watchtower/sources.js';
import { parseSource } from '../src/watchtower/feeds.js';
import { buildDigest, nextSeen, issueBody } from '../src/watchtower/digest.js';
import { checkStaleness } from '../src/watchtower/staleness.js';
import { renderDigestPage, digestFile, digestRoute, digestDescription } from '../src/watchtower/render.js';
import { addRewrite, addToIgnore, addToSitemap, addToIndex, addToLlms, ensureIndexStyles } from '../src/watchtower/wire.js';
import { SHELF_CURATED_AT } from '../src/model-shelf.js';
import { VERSION } from '../src/config.js';

const root = path.resolve(import.meta.dirname, '..');
const at = (...parts) => path.join(root, ...parts);
const readFile = (file) => fs.readFileSync(at(file), 'utf8');
const writeFile = (file, text) => fs.writeFileSync(at(file), text);

const STATE_DIR = 'watchtower';
const SEEN = `${STATE_DIR}/seen.json`;
const LAST_RUN = `${STATE_DIR}/last-run.json`;
const CACHE = `${STATE_DIR}/cache.json`;

const flags = new Set(process.argv.slice(2));
const dryRun = flags.has('--dry-run');
const offline = flags.has('--offline');

/** Read one source. A source that fails is reported and skipped, never fatal. */
async function readSource(source) {
  try {
    const res = await fetch(source.url, {
      signal: AbortSignal.timeout(20_000),
      headers: {
        // Identify honestly: a feed's operator should be able to see who we
        // are and tell us to stop.
        'user-agent': `SovereignAI-watchtower/${VERSION} (+https://mysovereign.ai; https://github.com/mlmrx/SovereignAI)`,
        accept: 'application/atom+xml, application/rss+xml, application/json, text/xml;q=0.9, */*;q=0.8',
      },
    });
    if (!res.ok) return { source, items: [], error: `HTTP ${res.status}` };
    const items = parseSource(source.kind, await res.text());
    return { source, items, error: items.length ? null : 'parsed zero items' };
  } catch (err) {
    return { source, items: [], error: err.name === 'TimeoutError' ? 'timed out' : String(err.message ?? err).slice(0, 120) };
  }
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(readFile(file));
  } catch {
    return fallback;
  }
}

/** Every published post and its date, read from the pages themselves. */
function publishedPosts() {
  return fs
    .readdirSync(at('public'))
    .filter((file) => /^blog-.+\.html$/.test(file))
    .map((file) => {
      const html = fs.readFileSync(at('public', file), 'utf8');
      return {
        slug: file.replace(/^blog-/, '').replace(/\.html$/, ''),
        date: html.match(/"datePublished":\s*"(\d{4}-\d{2}-\d{2})"/)?.[1] ?? null,
        digest: /^blog-signals-/.test(file),
      };
    });
}

async function main() {
  fs.mkdirSync(at(STATE_DIR), { recursive: true });
  const seen = loadJson(SEEN, {});
  const now = Date.now();

  const fetched = offline
    ? loadJson(CACHE, []).map((row) => ({ source: SOURCES.find((s) => s.id === row.sourceId) ?? { id: row.sourceId, label: row.sourceId, category: 'platform' }, items: row.items, error: null }))
    : await Promise.all(SOURCES.map(readSource));

  for (const { source, items, error } of fetched) {
    console.log(`  ${error ? 'skip' : ' ok '} ${source.label.padEnd(22)} ${String(items.length).padStart(3)} item(s)${error ? ` — ${error}` : ''}`);
  }
  const dead = fetched.filter((row) => row.error);
  // A source list is an opinion that rots: when a feed moves, the watchtower
  // reports a quiet week that was not quiet. Say so rather than shrug.
  const sourceNotes = dead.map((row) => ({
    id: `source:${row.source.id}`,
    severity: dead.length > SOURCES.length / 3 ? 'alarm' : 'warn',
    message: `${row.source.label} returned nothing (${row.error}). If that persists, its feed has moved and src/watchtower/sources.js needs the new URL.`,
  }));

  const posts = publishedPosts();
  const staleness = [
    ...checkStaleness({
      shelfCuratedAt: SHELF_CURATED_AT,
      sourcesCuratedAt: SOURCES_CURATED_AT,
      posts,
      lastDigestDate: posts.filter((p) => p.digest).map((p) => p.date).sort().at(-1) ?? null,
      now,
    }),
    ...sourceNotes,
  ];

  const digest = buildDigest({ fetched, seen, now, staleness });
  console.log(`\n${digest.counts.found} new, ${digest.counts.shown} publishable, ${digest.counts.security} security, ${staleness.length} staleness note(s)`);

  const result = {
    date: digest.date,
    published: false,
    route: digestRoute(digest.date),
    counts: digest.counts,
    staleness,
    security: digest.security,
    issue: issueBody(digest, { runUrl: process.env.GITHUB_RUN_URL ?? null }),
  };

  if (!digest.worthPublishing) {
    console.log('Nothing new worth publishing. No post, no commit — a quiet week is allowed to be quiet.');
  } else if (dryRun) {
    console.log(`Would publish ${digestFile(digest.date)} at ${result.route}`);
    console.log(`  description (${digestDescription(digest).length} chars): ${digestDescription(digest).slice(0, 120)}…`);
  } else {
    publish(digest);
    result.published = true;
    console.log(`Published ${digestFile(digest.date)} and wired 7 places.`);
  }

  // The run report is always written, dry run included: it is this run's
  // answer, and a caller that had to fall back to the previous run's file
  // would read a stale verdict. That is not hypothetical — the first CI dry
  // run did exactly that, saw `published: true` from a committed report, and
  // walked into the commit step with nothing to commit.
  writeFile(LAST_RUN, `${JSON.stringify(result, null, 2)}\n`);
  // A dry run changes nothing else: the seen record and the fetch cache are
  // the only state that would alter what a later real run decides.
  if (!dryRun) {
    writeFile(SEEN, `${JSON.stringify(nextSeen({ seen, fetched, now }), null, 0)}\n`);
    if (!offline) writeFile(CACHE, `${JSON.stringify(fetched.map(({ source, items }) => ({ sourceId: source.id, items })), null, 0)}\n`);
  }
  // Hand the verdict straight to the workflow rather than making it re-read a
  // file, so the gate can never be driven by a previous run's leftovers.
  if (process.env.GITHUB_OUTPUT) {
    // An issue only when there is something in it. A week where every source
    // was already seen and nothing has gone stale is a week with no post AND
    // no notification — fifty-two empty issues a year would train everyone to
    // ignore the one that matters.
    const worthAnIssue = digest.counts.found > 0 || staleness.length > 0;
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `published=${result.published}\ndate=${result.date}\nissue=${worthAnIssue}\n`);
  }
  return result;
}

/** Write the page and wire it into every place the site expects it. */
function publish(digest) {
  const file = digestFile(digest.date);
  const route = digestRoute(digest.date);
  writeFile(`public/${file}`, renderDigestPage(digest));
  writeFile('vercel.json', addRewrite(readFile('vercel.json'), route, file));
  writeFile('public/.vercelignore', addToIgnore(readFile('public/.vercelignore'), file));
  writeFile('public/sitemap.xml', addToSitemap(readFile('public/sitemap.xml'), route, digest.date));
  const index = addToIndex(ensureIndexStyles(readFile('public/blog.html')), { route, date: digest.date, count: digest.counts.shown });
  writeFile('public/blog.html', index);
  writeFile('public/llms.txt', addToLlms(readFile('public/llms.txt'), { route, date: digest.date, count: digest.counts.shown }));
}

main().catch((err) => {
  console.error(`watchtower failed: ${err.stack ?? err.message}`);
  process.exitCode = 1;
});
