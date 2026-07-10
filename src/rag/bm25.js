/**
 * Minimal BM25 ranking over an in-memory set of documents.
 * Sovereign by design: pure JS, no external index, works fully offline.
 */

const K1 = 1.4;
const B = 0.75;
export const MAX_QUERY_TERMS = 128;

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
    this.postings = new Map(); // term -> [doc index, term frequency][]
    let totalLen = 0;
    for (const doc of docs) {
      const terms = tokenize(doc.text);
      const tf = new Map();
      for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1);
      const docIndex = this.docs.length;
      for (const [term, count] of tf) {
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
        const posting = this.postings.get(term) ?? [];
        posting.push([docIndex, count]);
        this.postings.set(term, posting);
      }
      this.docs.push({ id: doc.id, len: terms.length });
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
    const queryTerms = boundedUniqueTerms(query, MAX_QUERY_TERMS);
    const byDocument = new Map();
    for (const term of queryTerms) {
      const idf = this.idf(term);
      for (const [docIndex, tf] of this.postings.get(term) ?? []) {
        const doc = this.docs[docIndex];
        const score = (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.len) / (this.avgLen || 1)));
        byDocument.set(docIndex, (byDocument.get(docIndex) ?? 0) + score);
      }
    }
    const scores = [...byDocument].map(([docIndex, score]) => ({ id: this.docs[docIndex].id, score }));
    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, limit);
  }
}

function boundedUniqueTerms(text, limit) {
  const terms = new Set();
  for (const match of String(text).toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    if (match[0].length <= 1) continue;
    terms.add(match[0]);
    if (terms.size >= limit) break;
  }
  return terms;
}
