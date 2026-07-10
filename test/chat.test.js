import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectMemories, trimHistory } from '../src/chat.js';

test('trimHistory never lets one oversized turn bypass the character budget', () => {
  const history = trimHistory([
    { role: 'user', content: 'old question' },
    { role: 'assistant', content: 'x'.repeat(500) },
  ], 100);
  assert.ok(history.reduce((sum, message) => sum + message.content.length, 0) <= 100);
});

test('selectMemories prefers relevant notes and enforces prompt bounds', () => {
  const memories = [
    { id: 'old', content: 'The user prefers concise answers.' },
    { id: 'project', content: 'The Atlas project uses SQLite and local models.' },
    { id: 'recent', content: 'The user drinks tea.' },
  ];
  const selected = selectMemories(memories, 'What database does Atlas use?', { maxChars: 55, maxItems: 2 });
  assert.equal(selected[0].id, 'project');
  assert.ok(selected.reduce((sum, memory) => sum + memory.content.length, 0) <= 55);
  assert.ok(selected.length <= 2);
});

test('selectMemories bounds query terms and candidate scanning before ranking', () => {
  const memories = Array.from({ length: 30 }, (_, index) => ({
    id: `memory-${index}`,
    content: index === 0 ? 'legacy target detail' : `recent note ${index}`,
  }));
  const query = `${Array.from({ length: 5000 }, (_, index) => `term${index}`).join(' ')} target`;
  const selected = selectMemories(memories, query, { maxItems: 3, maxTerms: 16, maxCandidates: 10 });

  assert.equal(selected.some((memory) => memory.id === 'memory-0'), false, 'only the bounded recent candidate set is scanned');
  assert.ok(selected.every((memory) => Number(memory.id.slice(7)) >= 20));
  assert.equal(selected.length, 3);
});
