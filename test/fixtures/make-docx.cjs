// Generates test/fixtures/sample.docx — a minimal, valid DOCX (ZIP) with
// mixed stored + deflated entries so both zip-reader paths are exercised.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const documentXml = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Sovereign AI Manifesto</w:t></w:r></w:p><w:p><w:r><w:t>The user owns the runtime &amp; the data.</w:t></w:r><w:r><w:t xml:space="preserve"> Always.</w:t></w:r></w:p><w:p><w:r><w:t>Tabs</w:t></w:r><w:tab/><w:r><w:t>work.</w:t></w:r></w:p></w:body></w:document>`;

const contentTypes = `<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

const rels = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

const entries = [
  { name: '[Content_Types].xml', data: Buffer.from(contentTypes), deflate: false },
  { name: '_rels/.rels', data: Buffer.from(rels), deflate: false },
  { name: 'word/document.xml', data: Buffer.from(documentXml), deflate: true },
];

const localParts = [];
const centralParts = [];
let offset = 0;

for (const { name, data, deflate } of entries) {
  const nameBuf = Buffer.from(name);
  const crc = zlib.crc32(data);
  const compressed = deflate ? zlib.deflateRawSync(data) : data;
  const method = deflate ? 8 : 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  localParts.push(local, nameBuf, compressed);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(offset, 42);
  centralParts.push(central, nameBuf);

  offset += 30 + nameBuf.length + compressed.length;
}

const centralStart = offset;
const centralBuf = Buffer.concat(centralParts);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(entries.length, 8);
eocd.writeUInt16LE(entries.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(centralStart, 16);

const out = path.join(__dirname, 'sample.docx');
fs.writeFileSync(out, Buffer.concat([...localParts, centralBuf, eocd]));
console.log('wrote', out, fs.statSync(out).size, 'bytes');
