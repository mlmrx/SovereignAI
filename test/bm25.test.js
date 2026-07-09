import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bm25Index, tokenize } from '../src/rag/bm25.js';

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
