/**
 * The digest as a published page.
 *
 * This is a template with holes, not a writer. The only sentences on the page
 * that are not a project's own headline are the ones written here by hand, and
 * they say the same thing every week — including, in plain sight, that the
 * page was assembled by a machine and what that does and does not guarantee.
 *
 * Every value from a feed is escaped on the way in. The page carries no inline
 * script, because the site's Content-Security-Policy forbids it and a page
 * that violates it is broken in production rather than merely untidy.
 */

const SITE = 'https://mysovereign.ai';

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `blog-signals-2026-09-07.html` ⇄ `/blog/signals-2026-09-07`. */
export const digestSlug = (date) => `signals-${date}`;
export const digestFile = (date) => `blog-${digestSlug(date)}.html`;
export const digestRoute = (date) => `/blog/${digestSlug(date)}`;

/** A long-enough, honest description: what is in this week, by section. */
export function digestDescription(digest) {
  const parts = digest.categories.map((category) => `${category.items.length} in ${category.label.toLowerCase()}`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
  return `Everything the watchtower found in local-AI primary sources for the week of ${digest.date}: ${list}. Every entry links the announcement it came from; nothing here is summarized or rewritten.`;
}

const humanDate = (date) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

function renderItem(item) {
  const when = item.date ? `<span class="when">${escapeHtml(item.date)}</span>` : '';
  const note = item.summary ? `<p class="sig-note">${escapeHtml(item.summary)}</p>` : '';
  return `        <li>
          <p class="sig-head"><span class="who">${escapeHtml(item.sourceLabel)}</span><a href="${escapeHtml(item.url)}" rel="noopener nofollow">${escapeHtml(item.title)}</a>${when}</p>
${note ? `${note}\n` : ''}        </li>`;
}

function renderCategory(category) {
  return `    <section class="sig-group">
      <h2 class="serif">${escapeHtml(category.label)}</h2>
      <p class="sig-blurb">${escapeHtml(category.blurb)}</p>
      <ul class="signals">
${category.items.map(renderItem).join('\n')}
      </ul>
    </section>`;
}

/** The sources block: every feed this digest actually read, named and linked. */
function renderSources(digest) {
  const seen = new Map();
  for (const category of digest.categories) {
    for (const item of category.items) if (!seen.has(item.sourceId)) seen.set(item.sourceId, item.sourceLabel);
  }
  return [...seen.entries()]
    .map(([, label]) => `      <li>${escapeHtml(label)}</li>`)
    .join('\n');
}

export function renderDigestPage(digest) {
  const slug = digestSlug(digest.date);
  const route = digestRoute(digest.date);
  const title = `Signals: what shipped in local AI, week of ${humanDate(digest.date)}`;
  const description = digestDescription(digest);
  const total = digest.counts.shown;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}" />
<link rel="canonical" href="${SITE}${route}" />
<link rel="alternate" type="application/atom+xml" title="The SovereignAI blog" href="/feed.xml" />
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><path fill='%23d97757' d='M50 4 90 27v46L50 96 10 73V27z'/><path fill='%231f1e1d' d='M34 29h34v10H45v7h18v10H45v7h23v10H34z'/></svg>" />
<meta property="og:type" content="article" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(`${total} releases and announcements from local-AI primary sources, week of ${digest.date}. Each one links its own announcement.`)}" />
<meta property="og:url" content="${SITE}${route}" />
<meta property="og:site_name" content="SovereignAI" />
<meta property="article:published_time" content="${digest.date}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="Signals, week of ${escapeHtml(humanDate(digest.date))}" />
<meta name="twitter:description" content="What actually shipped in local AI this week, from primary sources only." />
<link rel="stylesheet" href="/doc.css" />
<link rel="stylesheet" href="/shell.css" />
<script src="/shell.js"></script>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "BlogPosting",
  "headline": ${JSON.stringify(title)},
  "description": ${JSON.stringify(description)},
  "datePublished": "${digest.date}",
  "dateModified": "${digest.date}",
  "inLanguage": "en",
  "mainEntityOfPage": "${SITE}${route}",
  "isPartOf": { "@type": "Blog", "name": "The SovereignAI blog", "url": "${SITE}/blog" },
  "author": { "@type": "Organization", "name": "Unify Dynamics", "url": "${SITE}" },
  "publisher": { "@type": "Organization", "name": "Unify Dynamics", "url": "${SITE}" },
  "keywords": "local AI, open weights, Ollama, FreeToken, Hugging Face, model releases, local-first AI"
}
</script>
<style>
  .byline { font-size: 0.82rem; color: var(--dim); margin: -6px 0 22px; letter-spacing: 0.02em; }
  .machine { border-left: 3px solid var(--terra); padding: 4px 0 4px 16px; margin: 0 0 30px; font-size: 0.9rem; color: var(--dim); }
  .machine strong { color: var(--ink); }
  .sig-group { margin: 0 0 34px; }
  .sig-group h2 { margin: 0 0 4px; font-size: 1.3rem; }
  .sig-blurb { margin: 0 0 14px; color: var(--dim); font-size: 0.88rem; }
  .signals { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
  .signals li { border: 1px solid var(--rule); border-radius: 6px; padding: 13px 16px; background: var(--sheet); }
  .sig-head { margin: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; line-height: 1.45; }
  .sig-head .who { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 0.68rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--terra); }
  .sig-head a { color: inherit; font-weight: 600; text-decoration: none; }
  .sig-head a:hover { text-decoration: underline; }
  .sig-head .when { color: var(--dim); font-size: 0.72rem; font-variant-numeric: tabular-nums; margin-left: auto; }
  .sig-note { margin: 6px 0 0; color: var(--dim); font-size: 0.85rem; line-height: 1.5; }
  .series { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; border-top: 1px solid var(--rule); margin-top: 36px; padding-top: 16px; font-size: 0.88rem; }
  .series a { color: var(--terra); text-decoration: none; }
  .sources { font-size: 0.82rem; color: var(--dim); }
  .sources li { margin-bottom: 4px; }
  @media (max-width: 640px) { .sig-head .when { margin-left: 0; } }
</style>
</head>
<body>

<header class="shell-bar">
  <div class="shell-in">
    <a class="shell-brand" href="/">
      <svg viewBox="0 0 100 100" aria-hidden="true"><path fill="#d97757" d="M50 4 90 27v46L50 96 10 73V27z"/><path fill="#1b1a18" d="M34 29h34v10H45v7h18v10H45v7h23v10H34z"/></svg>
      SovereignAI
    </a>
    <nav class="shell-links">
      <a href="/">Home</a>
      <a href="/watch">Why</a>
      <a href="/playground">What</a>
      <a href="/command-center">How</a>
      <a href="/sovereignty">Ledger</a>
      <a href="/blog">Blog</a>
      <span class="shell-theme" data-theme-mount></span>
      <a class="shell-cta" href="/#install">Run it</a>
    </nav>
  </div>
</header>

<main>
  <article class="wrap">
    <p class="eyebrow"><a href="/blog" style="color:inherit;text-decoration:none">Blog</a> · Signals · ${escapeHtml(humanDate(digest.date))}</p>
    <h1 class="serif">${escapeHtml(title)}</h1>
    <p class="lede">${total} thing${total === 1 ? '' : 's'} shipped in local AI this week that we thought were worth knowing about. Every line below is a project's own announcement of its own work, linked back to where it was published.</p>
    <p class="byline">Assembled automatically from primary sources · no editor read this before it went up</p>

    <p class="machine"><strong>What this page is.</strong> A machine collected these from release feeds and model registries and formatted them. It did not summarize, rank by opinion, or add commentary — the words in each entry are the publisher's own words, and the date is theirs too. That is the whole reason it is allowed to publish itself: there is nothing here for a machine to get wrong except the copying, and the link beside every line is how you check it. Inclusion is not endorsement, and nothing here has been tested by us. The pages where we <em>do</em> make claims about our own product are written by people and reviewed, and our own limits stay recorded in the <a href="/sovereignty">Sovereignty Ledger</a>.</p>

${digest.categories.map(renderCategory).join('\n\n')}

    <h2 class="serif" id="sources">Sources</h2>
    <p>Every entry above links its own announcement. The feeds read this week:</p>
    <ul class="sources">
${renderSources(digest)}
    </ul>
    <p class="sources">The full source list, with a note on why each one is watched, is <a href="https://github.com/mlmrx/SovereignAI/blob/main/src/watchtower/sources.js" rel="noopener">in the repository</a> — as is the code that assembled this page. Nothing was fetched that is not in that file.</p>

    <div class="series">
      <a href="/blog">← All posts</a>
      <a href="/feed.xml">Follow by feed →</a>
    </div>
  </article>
</main>

<footer class="shell-foot">
  <div class="shell-in">
    <div class="mark"><svg viewBox="0 0 100 100" aria-hidden="true"><path fill="#d97757" d="M50 4 90 27v46L50 96 10 73V27z"/><path fill="#1b1a18" d="M34 29h34v10H45v7h18v10H45v7h23v10H34z"/></svg> SovereignAI</div>
    <div class="cols">
      <a href="/">Home</a>
      <a href="/watch">Watch</a>
      <a href="/a-day">A day with it</a>
      <a href="/command-center">Command center</a>
      <a href="/playground">Playground</a>
      <a href="/what-is-sovereign-ai">What is sovereign AI?</a>
      <a href="/why">The thesis</a>
      <a href="/sovereignty">Sovereignty ledger</a>
      <a href="/blog">Blog</a>
      <a href="/faq">FAQ</a>
      <a href="/#install">Run the trial</a>
      <a href="/#access">GitHub</a>
    </div>
    <p>Own every layer you can. Rent nothing you can&#39;t walk away from. · SovereignAI by Unify Dynamics · fair-source licensed (FSL-1.1-MIT), MIT after two years.</p>
    <p>This website counts nothing: no analytics, no cookie-less counter, no cross-site tracking. Your SovereignAI instance reports nothing to anyone either.</p>
  </div>
</footer>

</body>
</html>
`;
}
