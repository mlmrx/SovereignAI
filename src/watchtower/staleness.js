/**
 * The watchtower pointed at ourselves.
 *
 * Every dated claim on this site is a promise that decays. The starter shelf
 * says `curatedAt: 2026-08` and means it; the blog promises a monthly note on
 * what changed; the sources list is itself an opinion with a date on it. None
 * of that is enforced by a test, because none of it is wrong the day it is
 * written — it just quietly stops being true, and nobody notices until a
 * stranger does.
 *
 * These checks are warnings, never failures. A stale shelf does not break the
 * build; it earns a line in the weekly issue until someone deals with it.
 * Nothing here is ever published to the blog: telling readers our shelf is two
 * months old is not a post, it is a chore.
 */

const DAY = 86_400_000;
const MONTH = 30 * DAY;

/** Months between an ISO date (or YYYY-MM) and now, fractional. */
function monthsSince(dated, now) {
  if (typeof dated !== 'string' || !/^\d{4}-\d{2}(-\d{2})?$/.test(dated)) return null;
  const start = Date.parse(dated.length === 7 ? `${dated}-01` : dated);
  if (!Number.isFinite(start)) return null;
  return (now - start) / MONTH;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Assess what has gone stale. Pure: every input is passed in, including the
 * clock, so the thresholds can be tested without waiting three months.
 *
 * - `shelfCuratedAt`, `sourcesCuratedAt`: 'YYYY-MM' strings from their modules.
 * - `posts`: `[{ slug, date }]` — every published blog post, digests included.
 * - `lastDigestDate`: when the watchtower last published, or null.
 */
export function checkStaleness({ shelfCuratedAt, sourcesCuratedAt, posts = [], lastDigestDate = null, now = Date.now() }) {
  const notes = [];
  const add = (id, severity, message) => notes.push({ id, severity, message });

  const shelfAge = monthsSince(shelfCuratedAt, now);
  if (shelfAge !== null && shelfAge >= 6) {
    add('shelf', 'alarm', `The starter shelf was curated ${shelfCuratedAt} — ${plural(Math.floor(shelfAge), 'month')} ago. At this age its picks are advice about a landscape that has moved; re-curate or date it again deliberately.`);
  } else if (shelfAge !== null && shelfAge >= 3) {
    add('shelf', 'warn', `The starter shelf was curated ${shelfCuratedAt}, ${plural(Math.floor(shelfAge), 'month')} ago. Worth a review pass against this digest.`);
  }

  const sourcesAge = monthsSince(sourcesCuratedAt, now);
  if (sourcesAge !== null && sourcesAge >= 6) {
    add('sources', 'warn', `The watchtower's own source list was curated ${sourcesCuratedAt}, ${plural(Math.floor(sourcesAge), 'month')} ago. A watchtower watching the wrong horizon reports quiet weeks that are not quiet.`);
  }

  // The editorial promise: a monthly note on what actually changed. Digests
  // are excluded — a machine posting links does not discharge that promise.
  const essays = posts.filter((post) => post?.date && !post.digest).map((post) => post.date).sort();
  const newest = essays.at(-1);
  if (newest) {
    const days = Math.floor((now - Date.parse(newest)) / DAY);
    if (days >= 60) add('blog', 'alarm', `${plural(days, 'day')} since the last written post (${newest}). The blog promises a monthly note on what changed; two months of silence with weekly digests running is worse than no digests.`);
    else if (days >= 35) add('blog', 'warn', `${plural(days, 'day')} since the last written post (${newest}). The monthly note is due.`);
  }

  if (lastDigestDate) {
    const days = Math.floor((now - Date.parse(lastDigestDate)) / DAY);
    if (days >= 21) add('digest', 'warn', `${plural(days, 'day')} since the last digest published. Either the sources have gone quiet or the fetch is failing silently — check the run log.`);
  }

  return notes;
}

/**
 * Claims in the repository that name a version, so a release can never leave
 * the prose behind. Returns a note when a file still advertises a version
 * older than the one shipping.
 */
export function checkVersionDrift({ version, files = [] }) {
  const notes = [];
  for (const { path, text } of files) {
    for (const [, claimed] of String(text ?? '').matchAll(/\bv(\d+\.\d+\.\d+)\b/g)) {
      if (compareVersions(claimed, version) > 0) {
        notes.push({ id: `version:${path}`, severity: 'warn', message: `${path} names v${claimed}, which is ahead of the shipping version v${version} — a promise the product has not kept yet.` });
        break;
      }
    }
  }
  return notes;
}

function compareVersions(a, b) {
  const left = String(a).split('.').map(Number);
  const right = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) - (right[i] ?? 0);
  }
  return 0;
}
