/**
 * Wiring a published page into the site.
 *
 * A blog post is not one file. It is a file plus a route, a deploy allowlist
 * line, a sitemap entry, a card on the index, a line in llms.txt, and an entry
 * in the feed — seven places, every one of which fails the build if missed.
 * That is fine for a human writing one post a month and hopeless for a machine
 * publishing every week, so the machine gets a function per place.
 *
 * Each function takes the current file contents and returns the new contents,
 * so all of it is testable without touching the repository, and every one is
 * idempotent: wiring the same post twice is a no-op, not a duplicate. That
 * property is what makes a failed half-finished run safe to simply re-run.
 */

import { escapeHtml } from './render.js';

const SITE = 'https://mysovereign.ai';
const MARKER = '<!-- watchtower:signals -->';

/** Add the clean-route rewrite, keeping vercel.json's formatting stable. */
export function addRewrite(json, route, file) {
  const config = JSON.parse(json);
  if (config.rewrites.some((rule) => rule.source === route)) return json;
  config.rewrites.push({ source: route, destination: `/${file}` });
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Add the deploy allowlist line, next to the other posts. */
export function addToIgnore(ignore, file) {
  if (ignore.split(/\r?\n/).includes(`!${file}`)) return ignore;
  const anchor = '!robots.txt';
  if (!ignore.includes(anchor)) throw new Error('.vercelignore lost its robots.txt anchor');
  return ignore.replace(anchor, `!${file}\n${anchor}`);
}

/** Add the sitemap entry, newest posts before the static tail. */
export function addToSitemap(sitemap, route, date) {
  if (sitemap.includes(`<loc>${SITE}${route}</loc>`)) return sitemap;
  const entry = `  <url>\n    <loc>${SITE}${route}</loc>\n    <lastmod>${date}</lastmod>\n    <changefreq>yearly</changefreq>\n    <priority>0.5</priority>\n  </url>\n`;
  return sitemap.replace('</urlset>', `${entry}</urlset>`);
}

/**
 * Add the digest to the index's Signals archive, newest first.
 *
 * Digests are a compact dated list rather than cards: after a year there are
 * fifty of them, and a wall of identical cards would bury the seven written
 * posts this blog actually exists for. Every one is still linked, because an
 * unlinked page is an orphan no reader and no crawler will ever reach.
 */
export function addToIndex(html, { route, date, count }) {
  if (html.includes(`href="${route}"`)) return html;
  const entry = `        <li><a href="${route}">Week of ${escapeHtml(humanDate(date))}</a> <span class="sig-count">${count} item${count === 1 ? '' : 's'}</span></li>`;
  if (html.includes(MARKER)) {
    // Newest first, immediately after the marker that opens the list.
    return html.replace(MARKER, `${MARKER}\n${entry}`);
  }
  const section = `
    <p class="series-head">Signals · what shipped elsewhere, weekly, assembled automatically</p>
    <p class="sig-intro">Each week a machine reads the release feeds and model registries listed in the repository and formats what is new. No summarizing, no commentary, no editor — every line is a project's own announcement, linked back to it. The written posts above are the ones we stand behind; these are the raw record beside them.</p>
    <ul class="sig-archive">
${MARKER}
${entry}
    </ul>

    <div class="house">`;
  if (!html.includes('    <div class="house">')) throw new Error('blog.html lost its house-rules block');
  return html.replace('    <div class="house">', section);
}

/** The answer-engine index gets the same link, in its Blog section. */
export function addToLlms(llms, { route, date, count }) {
  if (llms.includes(`${SITE}${route}`)) return llms;
  const anchor = 'Feed: [Atom](https://mysovereign.ai/feed.xml)';
  if (!llms.includes(anchor)) throw new Error('llms.txt lost its feed anchor');
  const line = `Signals (weekly, assembled automatically from primary sources; each entry links the\nannouncement it came from, nothing is summarized): most recent\n[week of ${date}](${SITE}${route}), ${count} items.\n\n`;
  // Replace any previous Signals paragraph so llms.txt names the latest one
  // rather than growing a list nobody reads.
  const existing = /Signals \(weekly[\s\S]*?\n\n/;
  return existing.test(llms) ? llms.replace(existing, line) : llms.replace(anchor, `${line}${anchor}`);
}

function humanDate(date) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/** The CSS the index needs once the Signals section exists. */
export const INDEX_STYLES = `  .sig-intro { color: var(--dim); font-size: 0.9rem; margin: 0 0 12px; }
  .sig-archive { list-style: none; padding: 0; margin: 0 0 10px; display: grid; gap: 6px; font-size: 0.9rem; }
  .sig-archive li { display: flex; gap: 10px; align-items: baseline; padding: 7px 12px; border: 1px solid var(--rule); border-radius: 5px; background: var(--sheet); }
  .sig-archive a { color: inherit; text-decoration: none; font-weight: 600; }
  .sig-archive a:hover { color: var(--terra); text-decoration: underline; }
  .sig-count { color: var(--dim); font-size: 0.78rem; margin-left: auto; font-variant-numeric: tabular-nums; }
`;

/** Ensure the index carries the Signals styles exactly once. */
export function ensureIndexStyles(html) {
  if (html.includes('.sig-archive')) return html;
  const anchor = '  .house {';
  if (!html.includes(anchor)) throw new Error('blog.html lost its .house style anchor');
  return html.replace(anchor, `${INDEX_STYLES}${anchor}`);
}
