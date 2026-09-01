/**
 * Wiring a published answer into the site: the four places it has to reach or
 * it is invisible to a reader and to a crawler alike — a clean route, the
 * deploy allowlist, the sitemap, and a card on the Answers index.
 *
 * Every function takes the current file and returns the new one, and every one
 * is idempotent: wiring the same answer twice is a no-op. That is what makes a
 * half-finished run safe to simply re-run.
 *
 * The Answers index is the answer to "how does an LLM crawl all of them" — one
 * page, linked from every footer, that links every answer. The sitemap lists
 * them individually for completeness; llms.txt names the index rather than
 * enumerating pages, so it stays a guide instead of a log.
 */

import { escapeHtml } from './render.js';

const SITE = 'https://mysovereign.ai';
const MARKER = '<!-- answers:list -->';

export function addRoute(json, route, file) {
  const config = JSON.parse(json);
  if (config.rewrites.some((rule) => rule.source === route)) return json;
  // Keep the answer routes together, after the index route if it exists.
  config.rewrites.push({ source: route, destination: `/${file}` });
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function addToIgnore(ignore, file) {
  if (ignore.split(/\r?\n/).includes(`!${file}`)) return ignore;
  const anchor = '!robots.txt';
  if (!ignore.includes(anchor)) throw new Error('.vercelignore lost its robots.txt anchor');
  return ignore.replace(anchor, `!${file}\n${anchor}`);
}

export function addToSitemap(sitemap, route, date) {
  if (sitemap.includes(`<loc>${SITE}${route}</loc>`)) return sitemap;
  const entry = `  <url>\n    <loc>${SITE}${route}</loc>\n    <lastmod>${date}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n  </url>\n`;
  return sitemap.replace('</urlset>', `${entry}</urlset>`);
}

/**
 * Add the answer to the index, newest first. The index is a compact question
 * list rather than cards: after a hundred answers a wall of cards would bury
 * the point, and every one is still one click away.
 */
export function addToIndex(html, { route, question, date }) {
  if (html.includes(`href="${route}"`)) return html;
  const entry = `        <li><a href="${route}">${escapeHtml(question)}</a><span class="a-when">${escapeHtml(date)}</span></li>`;
  if (!html.includes(MARKER)) throw new Error('answers.html lost its list marker');
  // Drop the "nothing here yet" placeholder the moment there is something here.
  const withEntry = html.replace(MARKER, `${MARKER}\n${entry}`);
  return withEntry.replace(/\n\s*<li class="a-empty">[^<]*<\/li>/, '');
}
