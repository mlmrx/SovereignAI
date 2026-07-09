import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText } from '../src/rag/chunker.js';

test('short text yields a single chunk', () => {
  assert.deepEqual(chunkText('hello world'), ['hello world']);
});

test('empty text yields no chunks', () => {
  assert.deepEqual(chunkText('   '), []);
});

test('long text is split into bounded chunks', () => {
  const paragraph = 'The sovereign stack keeps data local. '.repeat(20);
  const text = Array.from({ length: 10 }, () => paragraph).join('\n\n');
  const chunks = chunkText(text, { maxChars: 1000, overlap: 100 });
  assert.ok(chunks.length > 1, 'should produce multiple chunks');
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 1000 + 120, `chunk too large: ${chunk.length}`);
  }
});

test('adjacent chunks share overlapping text', () => {
  const text = Array.from({ length: 40 }, (_, i) => `Paragraph number ${i} talks about topic ${i}.`).join('\n\n');
  const chunks = chunkText(text, { maxChars: 300, overlap: 80 });
  assert.ok(chunks.length >= 2);
  const tailOfFirst = chunks[0].slice(-40);
  assert.ok(chunks[1].includes(tailOfFirst.split(' ').at(-1)), 'second chunk should carry overlap from first');
});

test('single huge paragraph is hard-split', () => {
  const chunks = chunkText('x'.repeat(5000), { maxChars: 1000, overlap: 100 });
  assert.ok(chunks.length >= 5);
});
