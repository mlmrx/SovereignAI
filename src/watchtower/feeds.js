/**
 * Feed parsing for the watchtower: Atom, RSS, and the Hugging Face model API.
 *
 * Zero dependencies, like everything else here, so this is a tolerant
 * extractor rather than a conformant XML parser. That is a deliberate limit,
 * not a shortcut: the watchtower reads a handful of well-known feeds and needs
 * four fields from each item. Anything it cannot read confidently it drops,
 * because a garbled headline published automatically is worse than a missing
 * one.
 *
 * Nothing here trusts a feed. Every string that survives is unescaped once,
 * stripped of markup, collapsed to one line, and length-bounded — the values
 * end up in a published HTML page, and a feed is a stranger's input.
 */

/** Decode the entity set feeds actually use, plus numeric references. */
function decodeEntities(text) {
  return String(text ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Ampersand last: decoding it first would let "&amp;lt;" become "<".
    .replace(/&amp;/g, '&');
}

function safeCodePoint(code) {
  if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff) return ' ';
  try {
    return String.fromCodePoint(code);
  } catch {
    return ' ';
  }
}

/**
 * A feed value fit to publish: markup removed, entities decoded, one line,
 * bounded. Control characters go because they end up in a static page and in
 * a commit message.
 */
export function clean(value, max = 300) {
  const text = decodeEntities(String(value ?? ''))
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  // Cut on a word boundary so a truncated headline still reads as language.
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trim()}…`;
}

/** Only http(s) links are ever published; anything else is a dropped item. */
export function safeUrl(value) {
  const raw = decodeEntities(String(value ?? '')).trim();
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** An ISO date (YYYY-MM-DD) from whatever a feed calls a timestamp. */
export function isoDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const time = Date.parse(text);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString().slice(0, 10);
}

const tag = (block, name) => block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'))?.[1] ?? '';

/**
 * Parse an Atom or RSS document into `{ title, url, date, summary }` items.
 * Items without a title or a usable link are dropped rather than guessed at.
 */
export function parseFeed(xml) {
  const text = String(xml ?? '');
  const isAtom = /<feed[\s>]/i.test(text);
  const blocks = text.match(isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  const items = [];
  for (const block of blocks) {
    const title = clean(tag(block, 'title'), 200);
    // Atom puts the URL in an attribute; RSS puts it in the element body.
    const href = isAtom
      ? block.match(/<link[^>]*\srel=["']alternate["'][^>]*\shref=["']([^"']+)["']/i)?.[1] ??
        block.match(/<link[^>]*\shref=["']([^"']+)["']/i)?.[1]
      : tag(block, 'link') || block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i)?.[1];
    const url = safeUrl(href);
    if (!title || !url) continue;
    items.push({
      title,
      url,
      date: isoDate(tag(block, 'updated') || tag(block, 'published') || tag(block, 'pubDate') || tag(block, 'date')),
      summary: summarize(tag(block, 'summary') || tag(block, 'description') || tag(block, 'content')),
    });
  }
  return items;
}

/**
 * Parse the Hugging Face model API (`/api/models?...`), which is JSON rather
 * than a feed. A model's "headline" is its id; its date is when it was
 * created. Downloads and likes travel along so the digest can say why an
 * entry is worth a glance without anyone judging it.
 */
export function parseHuggingFace(body, { site = 'https://huggingface.co' } = {}) {
  let rows;
  try {
    rows = typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const items = [];
  for (const row of rows) {
    const id = clean(row?.id ?? row?.modelId ?? '', 120);
    if (!id || !/^[\w.-]+\/[\w.-]+$/.test(id)) continue;
    const url = safeUrl(`${site}/${id}`);
    if (!url) continue;
    const likes = Number(row?.likes);
    const downloads = Number(row?.downloads);
    const facts = [
      Number.isFinite(downloads) && downloads > 0 ? `${downloads.toLocaleString('en-US')} downloads` : null,
      Number.isFinite(likes) && likes > 0 ? `${likes} likes` : null,
      ...(Array.isArray(row?.tags) ? row.tags.filter((t) => typeof t === 'string' && /^(gguf|text-generation|moe)$/i.test(t)) : []),
    ].filter(Boolean);
    items.push({
      title: id,
      url,
      date: isoDate(row?.createdAt ?? row?.lastModified),
      summary: facts.join(' · '),
    });
  }
  return items;
}

/**
 * A summary fit to read beside a headline. Release notes are full of URLs,
 * attestation digests and co-author lines that mean nothing to a reader who
 * already has the link — strip them, and if what remains is too thin to be a
 * sentence, publish no summary rather than a fragment.
 */
export function summarize(value, max = 200) {
  const text = clean(value, 2000)
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\b[0-9a-f]{16,}\b/gi, '')
    .replace(/\bCo-authored-by:.*$/i, '')
    .replace(/\s*\(\s*#\d+\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (text.length < 25) return '';
  return clean(text, max);
}

/** Dispatch on the source's declared kind. Unknown kinds yield nothing. */
export function parseSource(kind, body) {
  if (kind === 'huggingface') return parseHuggingFace(body);
  if (kind === 'atom' || kind === 'rss') return parseFeed(body);
  return [];
}
