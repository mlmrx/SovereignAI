/**
 * An answer, as a published page.
 *
 * The page is built for two readers: a person who arrived from a search, and
 * the answer engine that will decide whether to cite it. Both want the same
 * thing — the direct answer first, then the detail, then the sources — so the
 * page leads with a one-sentence answer, marks it up as a schema.org QAPage,
 * and links every claim it can to a page that proves it.
 *
 * The answer text is authored in the bank and reviewed before it reaches here.
 * This file only formats it: a tiny, closed markup (links and bold) is the
 * only transformation, and every value is HTML-escaped before that markup is
 * applied, so even trusted in-repo prose cannot inject markup by accident.
 * The page carries no inline script — the site's Content-Security-Policy
 * forbids it.
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

export const answerFile = (slug) => `answers-${slug}.html`;
export const answerRoute = (slug) => `/answers/${slug}`;

/**
 * The closed markup the bank may use inside a paragraph: `[text](url)` links
 * (internal paths or https only) and `**bold**`. Everything is escaped first,
 * so the markup is applied to already-safe text and a stray bracket in the
 * prose renders as itself rather than as an anchor.
 */
export function renderProse(text) {
  let s = escapeHtml(text);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\[([^\]]+)\]\((\/[A-Za-z0-9/_-]*|https:\/\/[^\s)]+)\)/g, (_, label, url) => {
    const external = url.startsWith('http');
    return `<a href="${url}"${external ? ' rel="noopener"' : ''}>${label}</a>`;
  });
  return s;
}

/** The same text with the markup removed, for the JSON-LD answer body. */
export function toPlain(text) {
  return String(text ?? '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A one-sentence, ≥80-char meta description from the answer's own summary. */
export function answerDescription(answer) {
  return toPlain(answer.summary);
}

export function renderAnswerPage(answer) {
  const route = answerRoute(answer.slug);
  const description = answerDescription(answer);
  const plainAnswer = [answer.lead, ...answer.body].map(toPlain).join(' ');

  const related = (answer.related ?? [])
    .map(([href, label]) => `      <li><a href="${escapeHtml(href)}">${escapeHtml(label)}</a></li>`)
    .join('\n');
  const sources = (answer.sources ?? [])
    .map(([href, label]) => `      <li><a href="${escapeHtml(href)}" rel="noopener">${escapeHtml(label)}</a></li>`)
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(answer.question)}</title>
<meta name="description" content="${escapeHtml(description)}" />
<link rel="canonical" href="${SITE}${route}" />
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><path fill='%23d97757' d='M50 4 90 27v46L50 96 10 73V27z'/><path fill='%231f1e1d' d='M34 29h34v10H45v7h18v10H45v7h23v10H34z'/></svg>" />
<meta property="og:type" content="article" />
<meta property="og:title" content="${escapeHtml(answer.question)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:url" content="${SITE}${route}" />
<meta property="og:site_name" content="SovereignAI" />
<meta property="article:published_time" content="${answer.written}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(answer.question)}" />
<meta name="twitter:description" content="${escapeHtml(toPlain(answer.lead))}" />
<link rel="stylesheet" href="/doc.css" />
<link rel="stylesheet" href="/shell.css" />
<script src="/shell.js"></script>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "QAPage",
  "inLanguage": "en",
  "mainEntity": {
    "@type": "Question",
    "name": ${JSON.stringify(answer.question)},
    "text": ${JSON.stringify(answer.question)},
    "answerCount": 1,
    "acceptedAnswer": {
      "@type": "Answer",
      "text": ${JSON.stringify(plainAnswer)},
      "url": "${SITE}${route}",
      "author": { "@type": "Organization", "name": "Unify Dynamics", "url": "${SITE}" }
    },
    "author": { "@type": "Organization", "name": "Unify Dynamics" }
  },
  "keywords": ${JSON.stringify(answer.keywords)},
  "datePublished": "${answer.written}",
  "dateModified": "${answer.written}",
  "mainEntityOfPage": "${SITE}${route}",
  "publisher": { "@type": "Organization", "name": "Unify Dynamics", "url": "${SITE}" }
}
</script>
<style>
  .a-lead { font-size: 1.18rem; line-height: 1.55; border-left: 3px solid var(--terra); padding: 6px 0 6px 18px; margin: 0 0 24px; color: var(--ink); }
  .a-body p { margin: 0 0 16px; line-height: 1.7; }
  .a-body a { color: var(--terra); }
  .a-meta { font-size: 0.82rem; color: var(--dim); margin: -8px 0 24px; letter-spacing: 0.02em; }
  .a-related { border-top: 1px solid var(--rule); margin-top: 34px; padding-top: 18px; }
  .a-related h2 { font-size: 1.05rem; margin: 0 0 10px; }
  .a-related ul { margin: 0 0 8px; padding-left: 20px; }
  .a-related li { margin-bottom: 5px; }
  .a-related a { color: var(--terra); }
  .a-cta { border: 1px solid var(--rule); border-radius: 8px; background: var(--sheet); padding: 20px 24px; margin-top: 30px; }
  .a-cta .btn { display: inline-block; background: var(--terra); color: #fff; text-decoration: none; border-radius: 8px; padding: 11px 20px; font-weight: 650; }
  .sources { font-size: 0.86rem; color: var(--dim); }
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
    <p class="eyebrow"><a href="/answers" style="color:inherit;text-decoration:none">Answers</a> · a straight answer, sourced</p>
    <h1 class="serif">${escapeHtml(answer.question)}</h1>
    <p class="a-meta">Written ${escapeHtml(answer.written)} · reviewed before publishing · we link or source every claim</p>

    <p class="a-lead">${renderProse(answer.lead)}</p>
    <div class="a-body">
${answer.body.map((p) => `      <p>${renderProse(p)}</p>`).join('\n')}
    </div>

    <div class="a-related">
      <h2 class="serif">Read further</h2>
      <ul>
${related}
      </ul>${sources ? `
      <h2 class="serif" id="sources">Sources</h2>
      <ul class="sources">
${sources}
      </ul>` : ''}
    </div>

    <div class="a-cta">
      <h3 class="serif" style="margin-top:0">Own the answer, not just read it</h3>
      <p>SovereignAI is private AI you run yourself: local models, memory with receipts, disclosure at the moment
        anything leaves, and an exit you can verify. The trial is one Docker command, and deleting the volume
        deletes every trace of you.</p>
      <p><a class="btn" href="/#install">Run the open trial</a> · <a href="/three-questions">the test we hold ourselves to →</a></p>
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
      <a href="/answers">Answers</a>
      <a href="/three-questions">The three questions</a>
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
