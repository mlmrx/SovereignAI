/**
 * Minimal BM25 ranking over an in-memory set of documents.
 * Sovereign by design: pure JS, no external index, works fully offline.
 */

const K1 = 1.4;
const B = 0.75;

export function tokenize(text) {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
}

export class Bm25Index {
  /** @param {{id: string, text: string}[]} docs */
  constructor(docs) {
    this.docs = [];
    this.df = new Map(); // term -> number of docs containing it
    let totalLen = 0;
    for (const doc of docs) {
      const terms = tokenize(doc.text);
      const tf = new Map();
      for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1);
      for (const term of tf.keys()) this.df.set(term, (this.df.get(term) ?? 0) + 1);
      this.docs.push({ id: doc.id, tf, len: terms.length });
      totalLen += terms.length;
    }
    this.avgLen = this.docs.length ? totalLen / this.docs.length : 0;
  }

  idf(term) {
    const n = this.df.get(term) ?? 0;
    return Math.log(1 + (this.docs.length - n + 0.5) / (n + 0.5));
  }

  /** @returns {{id: string, score: number}[]} sorted descending, zero-score results omitted */
  search(query, limit = 10) {
    const queryTerms = [...new Set(tokenize(query))];
    const scores = [];
    for (const doc of this.docs) {
      let score = 0;
      for (const term of queryTerms) {
        const tf = doc.tf.get(term);
        if (!tf) continue;
        const idf = this.idf(term);
        score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.len) / (this.avgLen || 1)));
      }
      if (score > 0) scores.push({ id: doc.id, score });
    }
    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, limit);
  }
}
