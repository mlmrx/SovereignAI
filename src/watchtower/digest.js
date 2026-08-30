/**
 * Turning fetched feed items into a week's digest.
 *
 * Every function here is pure and takes its clock, so the whole publishing
 * decision is testable without a network or a calendar. That matters more than
 * usual: this digest publishes itself, and the only thing standing between a
 * bad week of feed data and the live site is the logic in this file.
 *
 * The digest is a FORMATTER, never an author. Each line it emits is a title a
 * project published about itself, the date it published it, and a link back.
 * Nothing is summarized, rephrased, or inferred — which is what makes it safe
 * to publish without anyone reading it first. The only prose on the page is
 * written by hand in the template and never changes.
 */

import { CATEGORIES, isRelevant, isPublishable, perSourceLimit } from './sources.js';

/** How old an item may be and still count as news, in days. */
export const FRESH_DAYS = 45;
// How long a URL stays remembered. It only has to outlast FRESH_DAYS by a
// margin: an item older than that is unpublishable anyway, so remembering it
// for a year would grow the file in the repository for no benefit. Undated
// items are the one exception, and they are rare.
export const REMEMBER_DAYS = 120;
/** Most items per category in one digest — a digest is a read, not an archive. */
export const PER_CATEGORY = 8;

const DAY = 86_400_000;
const iso = (time) => new Date(time).toISOString().slice(0, 10);

/**
 * The items worth publishing this run: new to us, recent, relevant to their
 * source, and carrying everything a reader needs to check the claim.
 *
 * An item with no date is kept — some feeds omit one — but an item with a date
 * older than FRESH_DAYS is dropped even if we have never seen it, because a
 * feed that suddenly exposes three years of history is not three years of news.
 */
export function selectItems({ fetched, seen = {}, now = Date.now() }) {
  const cutoff = iso(now - FRESH_DAYS * DAY);
  const chosen = [];
  const urls = new Set();
  for (const { source, items } of fetched) {
    for (const item of items ?? []) {
      if (!item?.url || !item?.title) continue;
      if (urls.has(item.url) || Object.hasOwn(seen, item.url)) continue;
      if (item.date && item.date < cutoff) continue;
      if (!isRelevant(source.id, item)) continue;
      if (!isPublishable(item)) continue;
      urls.add(item.url);
      chosen.push({ ...item, sourceId: source.id, sourceLabel: source.label, category: source.category });
    }
  }
  // Newest first; undated items sort last rather than pretending to be today.
  chosen.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.title.localeCompare(b.title));
  // Then the per-source cap, applied AFTER sorting so each source keeps its
  // newest items rather than whichever the feed happened to list first.
  const taken = new Map();
  return chosen.filter((item) => {
    const used = taken.get(item.sourceId) ?? 0;
    if (used >= perSourceLimit(item.sourceId)) return false;
    taken.set(item.sourceId, used + 1);
    return true;
  });
}

/**
 * Group the chosen items into the digest's sections. Security is pulled out
 * entirely: an advisory belongs in an issue someone is assigned, not in a
 * weekly read, and it must never wait a week behind a publishing decision.
 */
export function buildDigest({ fetched, seen = {}, now = Date.now(), staleness = [] }) {
  const items = selectItems({ fetched, seen, now });
  const security = items.filter((item) => item.category === 'security');
  const published = items.filter((item) => item.category !== 'security');

  const categories = CATEGORIES.filter((category) => category.id !== 'security')
    .map((category) => ({
      ...category,
      items: published.filter((item) => item.category === category.id).slice(0, PER_CATEGORY),
    }))
    .filter((category) => category.items.length > 0);

  const shown = categories.reduce((total, category) => total + category.items.length, 0);
  return {
    date: iso(now),
    categories,
    security,
    staleness,
    counts: { found: items.length, shown, held: published.length - shown, security: security.length },
    // Nothing new is not a slow week worth a post — it is a week with no post.
    // Staleness alone never justifies publishing; it goes to the issue instead.
    worthPublishing: shown > 0,
  };
}

/**
 * The seen-URL record for the next run: everything published or held from this
 * one, plus what was already known, minus anything old enough to be forgotten.
 * Held items are remembered too — they were offered and passed over, and
 * re-offering them next week would make every digest a repeat of the last.
 */
export function nextSeen({ seen = {}, fetched, now = Date.now() }) {
  const today = iso(now);
  const horizon = iso(now - REMEMBER_DAYS * DAY);
  const next = {};
  for (const [url, first] of Object.entries(seen)) {
    if (typeof first === 'string' && first >= horizon) next[url] = first;
  }
  for (const { items } of fetched) {
    for (const item of items ?? []) {
      if (item?.url && !next[item.url]) next[item.url] = today;
    }
  }
  return next;
}

/**
 * The digest as a GitHub issue body: the full picture including what was held
 * back and every staleness warning, for whoever is reading the repo rather
 * than the blog. Plain markdown, no HTML — this never reaches a web page.
 */
export function issueBody(digest, { runUrl = null } = {}) {
  const lines = [`Automated watchtower run for ${digest.date}.`, ''];
  if (digest.security.length) {
    lines.push('## Security — read first', '');
    for (const item of digest.security) lines.push(`- **${item.sourceLabel}**: [${item.title}](${item.url})${item.date ? ` — ${item.date}` : ''}`);
    lines.push('');
  }
  if (digest.staleness.length) {
    lines.push('## Staleness', '');
    for (const note of digest.staleness) lines.push(`- ${note.severity === 'alarm' ? '**' : ''}${note.message}${note.severity === 'alarm' ? '**' : ''}`);
    lines.push('');
  }
  for (const category of digest.categories) {
    lines.push(`## ${category.label}`, '');
    for (const item of category.items) lines.push(`- **${item.sourceLabel}**: [${item.title}](${item.url})${item.date ? ` — ${item.date}` : ''}`);
    lines.push('');
  }
  if (!digest.categories.length && !digest.security.length) lines.push('Nothing new in any watched source. No post was published.', '');
  const { found, shown, held } = digest.counts;
  lines.push('---', '', `${found} new item(s) found, ${shown} published, ${held} held back by the per-section cap.`);
  if (runUrl) lines.push('', `[Run log](${runUrl})`);
  return lines.join('\n');
}
