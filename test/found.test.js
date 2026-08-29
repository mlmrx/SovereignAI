// The found screen (ADR-27): a search ends in the passage that answers, not a
// listing. These pin the ranking signals a person uses (coverage of their
// terms, the document's own name) and the focus window that puts the answering
// sentence first — and that the UI renders one object, then the rest, quietly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { retrieve, coverageTerms, coverage, focusWindow } from '../src/rag/retriever.js';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const LEASE = 'STUDIO LEASE AGREEMENT — 2026. Clause 3. Term. The initial term runs twelve months from 1 March 2026. Clause 14. Renewal. This agreement renews automatically for successive one-year terms each March unless either party gives written notice of non-renewal no later than sixty (60) days before the renewal date. Rent for any renewal term increases by the lesser of 3% or the published CPI figure. Clause 15. Deposit. The security deposit of two months\' rent is held in a separate account and returned within 30 days of move-out, less documented damages. Clause 21. Notices. Notices must be delivered in writing to the addresses on the signature page.';
const INSURANCE = 'SHIELD CONTENTS INSURANCE — POLICY SCHEDULE. The policy term runs twelve months from the commencement date stated in the schedule and renews on written confirmation. Studio equipment is covered up to $40,000 per event; the excess is $500. Claims must be lodged within 14 days. The policy does not cover equipment left in an unattended vehicle overnight.';
const NOTES = 'Ops meeting, 12 August 2026. Lease: renewal window opens in January; decide by 1 January whether to give notice (60 days before 1 March). Ask landlord about the CPI clause. Insurance: renewal quote due in October; get two comparison quotes. Subscriptions audit: cancel the two design tools nobody used since May. Hiring: hold until Q4.';

function fakeStore(docs) {
  let version = '1:1';
  return {
    getKnowledgeVersion: () => version,
    listAllChunks: () => docs.map(([name, content], i) => ({ id: `c${i}`, document_id: `d${i}`, document_name: name, content, embedding: null })),
  };
}
const config = {
  limits: { ragChunks: 6 },
  embeddings: { provider: 'ollama', model: '' },
  providers: { ollama: { enabled: false, baseUrl: 'http://localhost:11434' } },
};

test('coverage terms are the words a person means: three letters or more, no noise', () => {
  assert.deepEqual(coverageTerms('when does the lease renew?'), ['lease', 'renew']);
  assert.deepEqual(coverageTerms('What is my deposit'), ['deposit']);
  assert.deepEqual(coverageTerms(''), []);
});

test('coverage matches by prefix so "renew" finds renews and renewal, but "lease" does not find "least"', () => {
  const terms = coverageTerms('lease renew');
  assert.deepEqual(coverage('the agreement renews each March', terms).hit, ['renew']);
  assert.deepEqual(coverage('renewal window opens in January for the lease', terms).hit, ['lease', 'renew']);
  assert.deepEqual(coverage('at least twelve months', terms).hit, []);
  assert.equal(coverage('nothing here', terms).ratio, 0);
});

test('the focus window is the sentence that answers, grown to its neighbours within the width', () => {
  const focus = focusWindow(LEASE, coverageTerms('when does the lease renew'), 240);
  assert.ok(focus.startsWith('Clause 14. Renewal.') || focus.includes('renews automatically'), `focus should open on the renewal clause, got: ${focus}`);
  assert.ok(focus.length <= 240, 'the window respects its width');
  assert.doesNotMatch(focus, /Clause 21/, 'the window does not run to the end of the chunk');
  assert.equal(focusWindow('short text', ['text']), 'short text', 'a short passage is returned whole');
});

test('the passage that answers ranks first: coverage of the terms and the document name beat a short chunk with one repeated word', async () => {
  const store = fakeStore([['insurance-policy-shield.txt', INSURANCE], ['meeting-notes-2026-08-12.md', NOTES], ['studio-lease-2026.pdf', LEASE]]);
  const results = await retrieve({ store, config, query: 'when does the lease renew', limit: 8 });
  assert.equal(results[0].document, 'studio-lease-2026.pdf', 'the lease clause is the find');
  assert.equal(results[1].document, 'meeting-notes-2026-08-12.md', 'the notes that mention the lease renewal come next');
  assert.equal(results[2].document, 'insurance-policy-shield.txt', 'the policy that merely "renews" comes last');
  assert.deepEqual(results[0].terms, ['lease', 'renew']);
  assert.equal(results[0].coverage, 1);
  assert.ok(results[0].rank > results[1].rank && results[1].rank > results[2].rank, 'rank is what the order follows');
  assert.match(results[0].focus, /renews automatically/, 'the found passage opens on the answer');
  // The fields chat has always used are untouched.
  for (const r of results) {
    assert.ok(typeof r.content === 'string' && r.content.length > 0);
    assert.equal(r.method, 'keyword');
    assert.ok(r.score >= 0 && r.score <= 1);
  }
});

test('a chunk with no scored term but a covered prefix is still found', async () => {
  const store = fakeStore([['renewals.md', 'Renewals happen every March.'], ['other.md', 'Nothing relevant lives here at all.']]);
  const results = await retrieve({ store, config, query: 'renew', limit: 8 });
  assert.equal(results.length, 1);
  assert.equal(results[0].document, 'renewals.md');
  assert.deepEqual(results[0].terms, ['renew']);
});

test('the found screen renders one object first, the rest quietly, and a receipt — never a directory', () => {
  const app = read('public/app.js');
  const html = read('public/app.html');
  const css = read('public/style.css');
  assert.match(app, /kb-found/, 'the best passage is rendered as the found object');
  assert.match(app, /kb-also/, 'the rest are rendered as "also found"');
  assert.match(app, /kb-receipt/, 'a receipt line says method, passages, and what would reach the model');
  assert.match(app, /Nothing in your documents says that/, 'nothing is a result too');
  assert.match(app, /Ask about this/, 'the object has a next step');
  assert.match(app, /best\.focus/, 'the UI shows the focus window, not the first 650 characters');
  assert.doesNotMatch(app, /content\.slice\(0, 650\)/, 'the old 650-character slab is gone');
  assert.doesNotMatch(app, /Keyword fallback/, 'the badge vocabulary is retired');
  assert.match(html, /Ask your documents/, 'the section stops introducing itself as a debug view');
  assert.doesNotMatch(html, /Retrieval preview/, 'the debug eyebrow is retired');
  assert.match(css, /prefers-reduced-motion: reduce\)\s*\{\s*\.kb-settle/, 'the arrival respects reduced motion');
  // Highlighting escapes first and marks only word matches (no HTML from documents reaches the DOM).
  assert.match(app, /function highlightTerms/);
  assert.match(app, /escapeHtml\(text\)[\s\S]*<mark>/, 'text is escaped before marks are inserted');
});

test('the public demo answers the knowledge search in the real shape', () => {
  const demo = read('public/demo-api.js');
  const block = demo.slice(demo.indexOf("'/api/search':"), demo.indexOf("'/api/model-shelf'"));
  assert.match(block, /'\/api\/search': \[/, 'an array, as the real route returns');
  for (const field of ['documentId', 'document', 'content', 'score', 'method', 'rank', 'coverage', 'terms', 'focus']) {
    assert.ok(block.includes(`${field}:`), `fixture items carry ${field}`);
  }
});
