import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { readZipEntries } from '../src/ingest/zip.js';
import { extractDocx } from '../src/ingest/docx.js';
import { extractPdf } from '../src/ingest/pdf.js';
import { extractText } from '../src/ingest/index.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const docx = fs.readFileSync(path.join(fixtures, 'sample.docx'));
const pdf = fs.readFileSync(path.join(fixtures, 'sample.pdf'));

test('zip reader lists and reads stored + deflated entries', () => {
  const zip = readZipEntries(docx);
  assert.ok(zip.names.includes('word/document.xml'));
  assert.ok(zip.names.includes('[Content_Types].xml'));
  const doc = zip.read('word/document.xml').toString('utf8'); // deflated entry
  assert.ok(doc.includes('Sovereign AI Manifesto'));
  const ct = zip.read('[Content_Types].xml').toString('utf8'); // stored entry
  assert.ok(ct.includes('content-types'));
  assert.equal(zip.read('missing.xml'), null);
});

test('docx extraction: paragraphs, entities, tabs', () => {
  const text = extractDocx(docx);
  assert.ok(text.includes('Sovereign AI Manifesto'));
  assert.ok(text.includes('The user owns the runtime & the data. Always.'));
  assert.ok(text.includes('Tabs\twork.'));
  assert.ok(text.includes('\n\n'), 'paragraph breaks preserved');
});

test('pdf extraction: uncompressed content stream', () => {
  const text = extractPdf(pdf);
  assert.ok(text.includes('Sovereign PDF extraction works.'));
  assert.ok(text.includes('Second line of text.'));
  assert.ok(text.includes('works.\nSecond'), 'T* should produce a line break');
});

test('pdf extraction: FlateDecode content stream', () => {
  const content = 'BT (Compressed sovereign text.) Tj ET';
  const deflated = zlib.deflateSync(Buffer.from(content, 'latin1'));
  const parts = [
    Buffer.from('%PDF-1.4\n4 0 obj << /Length ' + deflated.length + ' /Filter /FlateDecode >>\nstream\n', 'latin1'),
    deflated,
    Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1'),
  ];
  const text = extractPdf(Buffer.concat(parts));
  assert.ok(text.includes('Compressed sovereign text.'));
});

test('pdf extraction rejects unreadable output', () => {
  assert.throws(() => extractPdf(Buffer.from('%PDF-1.4\nno streams here\n%%EOF', 'latin1')), /Could not extract/);
});

test('extractText dispatches by extension', () => {
  assert.ok(extractText('a.docx', docx).includes('Manifesto'));
  assert.ok(extractText('a.pdf', pdf).includes('extraction works'));
  assert.equal(extractText('a.md', Buffer.from('# plain text')), '# plain text');
});

test('extractText rejects binary junk and legacy .doc', () => {
  assert.throws(() => extractText('a.bin', Buffer.from([0x4d, 0x5a, 0x00, 0x01, 0x00, 0x02])), /unsupported binary/);
  assert.throws(() => extractText('a.doc', Buffer.from('x')), /save it as \.docx/);
});
