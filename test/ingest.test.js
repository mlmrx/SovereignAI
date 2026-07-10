import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { MAX_ZIP_ENTRY_BYTES, readZipEntries } from '../src/ingest/zip.js';
import { extractDocx } from '../src/ingest/docx.js';
import { extractPdf, MAX_PDF_DICT_BYTES, MAX_PDF_STREAM_BYTES, MAX_PDF_STREAM_COUNT } from '../src/ingest/pdf.js';
import { extractText, MAX_EXTRACTED_TEXT_BYTES } from '../src/ingest/index.js';

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

test('zip reader rejects oversized decompression before allocating output', () => {
  const oversized = Buffer.from(docx);
  let found = false;
  for (let offset = 0; offset + 46 <= oversized.length; offset++) {
    if (oversized.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = oversized.readUInt16LE(offset + 28);
    const name = oversized.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name !== 'word/document.xml') continue;
    oversized.writeUInt32LE(MAX_ZIP_ENTRY_BYTES + 1, offset + 24);
    found = true;
    break;
  }
  assert.equal(found, true);
  const zip = readZipEntries(oversized);
  assert.throws(() => zip.read('word/document.xml'), /too large after decompression/);
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

test('pdf extraction caps inflated stream output', () => {
  const deflated = zlib.deflateSync(Buffer.alloc(MAX_PDF_STREAM_BYTES + 1, 0x41));
  const pdfBomb = Buffer.concat([
    Buffer.from('%PDF-1.4\n4 0 obj << /Filter /FlateDecode >>\nstream\n', 'latin1'),
    deflated,
    Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1'),
  ]);
  assert.throws(() => extractPdf(pdfBomb), /too large after decompression/);
});

test('pdf extraction bounds stream count and preceding dictionary scans', () => {
  const manyStreams = Buffer.from(
    '%PDF-1.4\n' + '<<>>\nstream\nBT (x) Tj ET\nendstream\n'.repeat(MAX_PDF_STREAM_COUNT + 1) + '%%EOF',
    'latin1'
  );
  assert.throws(() => extractPdf(manyStreams), /too many streams/);

  const distantDictionary = Buffer.from(
    '%PDF-1.4\n<< /Filter /FlateDecode >>\n' +
      ' '.repeat(MAX_PDF_DICT_BYTES + 1) +
      'stream\nBT (Bounded dictionary lookup.) Tj ET\nendstream\n%%EOF',
    'latin1'
  );
  assert.match(extractPdf(distantDictionary), /Bounded dictionary lookup/);
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

test('plain-text extraction enforces the output cap', () => {
  assert.throws(
    () => extractText('huge.txt', Buffer.alloc(MAX_EXTRACTED_TEXT_BYTES + 1, 0x61)),
    (err) => err.status === 413 && /extracted text is too large/.test(err.message)
  );
});
