import zlib from 'node:zlib';

/**
 * Minimal ZIP reader (zero deps) — enough to open DOCX/XLSX/PPTX containers.
 * Supports stored (0) and deflate (8) entries; no zip64, no encryption.
 */
export function readZipEntries(buffer) {
  const eocd = findEocd(buffer);
  if (eocd === -1) throw new Error('Not a ZIP archive');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16); // central directory start

  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.set(name, { method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return {
    names: [...entries.keys()],
    read(name) {
      const entry = entries.get(name);
      if (!entry) return null;
      const { localOffset, method, compressedSize } = entry;
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Corrupt ZIP: bad local header');
      const nameLength = buffer.readUInt16LE(localOffset + 26);
      const extraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + nameLength + extraLength;
      const data = buffer.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`Unsupported ZIP compression method: ${method}`);
    },
  };
}

function findEocd(buffer) {
  // EOCD signature 0x06054b50, scan backwards (comment can trail it, max 64KB)
  const min = Math.max(0, buffer.length - 65558);
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}
