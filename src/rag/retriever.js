import { Bm25Index } from './bm25.js';
import { cosine } from '../util.js';
import { getProvider } from '../providers/index.js';

/**
 * Hybrid retrieval over the local knowledge base:
 *  - semantic search via embeddings when an embedding model is available
 *  - BM25 keyword search always (offline fallback and hybrid signal)
 * Scores are blended when both signals exist.
 */
export async function retrieve({ store, config, query, limit }) {
  const chunks = store.listAllChunks();
  if (chunks.length === 0) return [];
  limit = limit ?? config.limits.ragChunks;

  const bm25 = new Bm25Index(chunks.map((c) => ({ id: c.id, text: c.content })));
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

  const scored = chunks
    .map((chunk) => {
      const kw = keywordScore.get(chunk.id) ?? 0;
      const sem = semanticScore?.get(chunk.id);
      const score = sem !== undefined ? 0.65 * sem + 0.35 * kw : kw;
      return { chunk, score, semantic: sem !== undefined };
    })
    .filter((r) => r.score > 0.01);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ chunk, score, semantic }) => ({
    id: chunk.id,
    document: chunk.document_name,
    content: chunk.content,
    score: Number(score.toFixed(4)),
    method: semantic ? 'hybrid' : 'keyword',
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
