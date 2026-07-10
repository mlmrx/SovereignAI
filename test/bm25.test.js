import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bm25Index, MAX_QUERY_TERMS, tokenize } from '../src/rag/bm25.js';
import { retrieve } from '../src/rag/retriever.js';

test('tokenize lowercases and strips punctuation', () => {
  assert.deepEqual(tokenize('Hello, World! It\'s 42.'), ['hello', 'world', 'it', '42']);
});

test('bm25 ranks the on-topic document first', () => {
  const index = new Bm25Index([
    { id: 'a', text: 'The quick brown fox jumps over the lazy dog' },
    { id: 'b', text: 'Sovereign AI means owning your models and your data' },
    { id: 'c', text: 'A recipe for sourdough bread with rye flour' },
  ]);
  const results = index.search('who owns the data in sovereign AI?');
  assert.equal(results[0].id, 'b');
});

test('bm25 returns empty for no matches', () => {
  const index = new Bm25Index([{ id: 'a', text: 'alpha beta gamma' }]);
  assert.deepEqual(index.search('zzz qqq'), []);
});

test('bm25 handles empty corpus', () => {
  const index = new Bm25Index([]);
  assert.deepEqual(index.search('anything'), []);
});

test('bm25 bounds unique query work before scoring the corpus', () => {
  const index = new Bm25Index([{ id: 'late', text: 'needle-after-the-bound' }]);
  const prefix = Array.from({ length: MAX_QUERY_TERMS }, (_, i) => `term${i}`).join(' ');
  assert.deepEqual(index.search(`${prefix} needle-after-the-bound`), []);
  assert.equal(index.search(`needle-after-the-bound ${prefix}`)[0].id, 'late');
});

test('retrieval caches the keyword corpus and invalidates it by store version', async () => {
  let version = '0:1';
  let reads = 0;
  const store = {
    getKnowledgeVersion: () => version,
    listAllChunks() {
      reads++;
      return [{
        id: 'chunk-1',
        document_id: 'doc-1',
        document_name: 'notes.md',
        content: 'SovereignAI retrieval cache test',
        embedding: null,
      }];
    },
  };
  const config = {
    limits: { ragChunks: 6 },
    embeddings: { provider: 'ollama', model: '' },
    providers: { ollama: { enabled: false, baseUrl: 'http://localhost:11434' } },
  };

  await retrieve({ store, config, query: 'retrieval cache' });
  await retrieve({ store, config, query: 'retrieval cache' });
  assert.equal(reads, 1);

  version = '1:1';
  await retrieve({ store, config, query: 'retrieval cache' });
  assert.equal(reads, 2);
});
