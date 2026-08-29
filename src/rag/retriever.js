import { Bm25Index, tokenize } from './bm25.js';
import { cosine } from '../util.js';
import { getProvider } from '../providers/index.js';

const keywordCache = new WeakMap();

// Words that carry no "find" signal. Kept tiny and English on purpose: this
// is not a stopword list for BM25 (which weighs terms by rarity anyway), it is
// the set of terms a person does not mean when they type a question.
const NOISE = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'her', 'was', 'one', 'our', 'out',
  'has', 'had', 'his', 'how', 'its', 'let', 'may', 'she', 'too', 'use', 'who', 'why', 'did', 'does', 'from',
  'have', 'into', 'more', 'most', 'that', 'than', 'them', 'then', 'they', 'this', 'what', 'when', 'where',
  'which', 'while', 'with', 'will', 'would', 'your', 'about', 'there', 'these', 'those', 'should', 'could',
]);

/**
 * The query terms a person actually means: three letters or more, not noise.
 * These drive coverage, the title signal, and the focus window — the "found"
 * half of retrieval, as opposed to the scoring half (ADR-27).
 */
export function coverageTerms(query) {
  return [...new Set(tokenize(query).filter((t) => t.length >= 3 && !NOISE.has(t)))];
}

// A term is covered by a token when they are equal, or when one is a prefix
// of the other and the shorter is at least four letters — so "renew" finds
// "renews" and "renewal" without a stemmer, and "lease" does not find "least".
function covers(token, term) {
  if (token === term) return true;
  const short = token.length < term.length ? token : term;
  const long = short === token ? term : token;
  return short.length >= 4 && long.startsWith(short);
}

/** Which of the query's terms a text covers, and the share of them. */
export function coverage(text, terms) {
  if (!terms.length) return { hit: [], ratio: 0 };
  const tokens = new Set(tokenize(text));
  const hit = terms.filter((term) => { for (const token of tokens) if (covers(token, term)) return true; return false; });
  return { hit, ratio: hit.length / terms.length };
}

/**
 * The span of a passage worth showing first: the sentence with the densest
 * coverage of the query, extended to its neighbours up to `width` characters.
 * Chunks are ~1200 characters; a person reads the 240 that answer them.
 */
export function focusWindow(content, terms, width = 240) {
  const text = String(content ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= width) return text;
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  // The best sentence covers the most distinct terms; among equals, the one
  // where the terms occur most often ("renews … non-renewal … renewal date"
  // beats a title that mentions the lease once); among those, the earliest.
  let best = 0;
  let bestDistinct = -1;
  let bestOccurrences = -1;
  sentences.forEach((sentence, i) => {
    const distinct = coverage(sentence, terms).hit.length;
    const occurrences = tokenize(sentence).filter((token) => terms.some((term) => covers(token, term))).length;
    if (distinct > bestDistinct || (distinct === bestDistinct && occurrences > bestOccurrences)) {
      bestDistinct = distinct;
      bestOccurrences = occurrences;
      best = i;
    }
  });
  let start = best;
  let end = best;
  let length = sentences[best].length;
  // Grow around the best sentence: forward first (what follows an answer is
  // usually its detail), then back, while the window stays within width.
  for (;;) {
    const next = end + 1 < sentences.length ? sentences[end + 1].length + 1 : Infinity;
    const prev = start > 0 ? sentences[start - 1].length + 1 : Infinity;
    if (next !== Infinity && length + next <= width) { end++; length += next; continue; }
    if (prev !== Infinity && length + prev <= width) { start--; length += prev; continue; }
    break;
  }
  let window = sentences.slice(start, end + 1).join(' ');
  if (window.length > width) {
    // One very long sentence: cut around the first covered term.
    const lower = window.toLowerCase();
    const at = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
    const from = Math.max(0, Math.min(at - Math.floor(width / 3), window.length - width));
    window = window.slice(from, from + width).trim();
  }
  return window;
}

/**
 * Hybrid retrieval over the local knowledge base:
 *  - semantic search via embeddings when an embedding model is available
 *  - BM25 keyword search always (offline fallback and hybrid signal)
 * Scores are blended when both signals exist. Ranking then adds the "found"
 * signals a person uses: how many of their terms a passage actually covers,
 * and whether the document's own name matches (ADR-27). The same ranking
 * feeds chat context and the knowledge search, so the preview is the truth.
 */
export async function retrieve({ store, config, query, limit }) {
  const version = store.getKnowledgeVersion?.() ?? null;
  let cached = version === null ? null : keywordCache.get(store);
  if (!cached || cached.version !== version) {
    const chunks = store.listAllChunks();
    cached = {
      version,
      chunks,
      index: new Bm25Index(chunks.map((chunk) => ({ id: chunk.id, text: chunk.content }))),
    };
    if (version !== null) keywordCache.set(store, cached);
  }
  const { chunks, index: bm25 } = cached;
  if (chunks.length === 0) return [];
  limit = limit ?? config.limits.ragChunks;

  const keywordHits = bm25.search(query, limit * 4);
  const maxKeyword = keywordHits[0]?.score ?? 0;
  const keywordScore = new Map(keywordHits.map((h) => [h.id, maxKeyword ? h.score / maxKeyword : 0]));

  let semanticScore = null;
  const queryVector = await embedQuery(config, query);
  if (queryVector) {
    semanticScore = new Map();
    for (const chunk of chunks) {
      if (!chunk.embedding) continue;
      semanticScore.set(chunk.id, cosine(queryVector, JSON.parse(chunk.embedding)));
    }
    if (semanticScore.size === 0) semanticScore = null;
  }

  const terms = coverageTerms(query);
  const scored = chunks
    .map((chunk) => {
      const kw = keywordScore.get(chunk.id) ?? 0;
      const sem = semanticScore?.get(chunk.id);
      const score = sem !== undefined ? 0.65 * sem + 0.35 * kw : kw;
      const cov = coverage(chunk.content, terms);
      const title = coverage(chunk.document_name ?? '', terms).hit.length > 0;
      // Coverage first, then the score, with a modest nod to a matching name:
      // a passage that mentions every term the person typed outranks one that
      // scored high on a single repeated word, and "studio-lease" beats a
      // stranger's file when both mention the lease.
      const rank = cov.ratio + score + (title ? 0.15 : 0);
      return { chunk, score, semantic: sem !== undefined, cov, rank };
    })
    .filter((r) => r.score > 0.01 || r.cov.hit.length > 0);

  scored.sort((a, b) => b.rank - a.rank);
  return scored.slice(0, limit).map(({ chunk, score, semantic, cov, rank }) => ({
    id: chunk.id,
    documentId: chunk.document_id,
    document: chunk.document_name,
    content: chunk.content,
    score: Number(score.toFixed(4)),
    method: semantic ? 'hybrid' : 'keyword',
    // The found signals, for the screen that shows one passage first.
    rank: Number(rank.toFixed(4)),
    coverage: Number(cov.ratio.toFixed(2)),
    terms: cov.hit,
    focus: focusWindow(chunk.content, terms),
  }));
}

/** Embed a batch of texts with the configured embedding model. Returns null when unavailable. */
export async function embedTexts(config, texts) {
  const { provider: providerId, model } = config.embeddings ?? {};
  if (!providerId || !model) return null;
  const provider = getProvider(providerId);
  const cfg = config.providers[providerId];
  if (!provider.embed || !provider.isConfigured(cfg)) return null;
  try {
    return await provider.embed(cfg, model, texts);
  } catch {
    return null; // embedding model not pulled / provider down — keyword search still works
  }
}

async function embedQuery(config, query) {
  const vectors = await embedTexts(config, [query]);
  return vectors?.[0] ?? null;
}

/** Format retrieved chunks as a context block for the system prompt. */
export function formatContext(results) {
  if (results.length === 0) return '';
  const blocks = results.map((r, i) => `[${i + 1}] (${r.document})\n${r.content}`).join('\n\n');
  return `Relevant excerpts from the user's private knowledge base (cite by [number] when used):\n\n${blocks}`;
}
