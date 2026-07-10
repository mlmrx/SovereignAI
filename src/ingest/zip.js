import zlib from 'node:zlib';

export const MAX_ZIP_ENTRIES = 4096;
export const MAX_ZIP_ENTRY_BYTES = 10 * 1024 * 1024;
export const MAX_ZIP_EXPANSION_RATIO = 250;

/**
 * Minimal ZIP reader (zero deps) — enough to open DOCX/XLSX/PPTX containers.
 * Supports stored (0) and deflate (8) entries; no zip64, no encryption.
 */
export function readZipEntries(buffer) {
  const eocd = findEocd(buffer);
  if (eocd === -1) throw new Error('Not a ZIP archive');
  const count = buffer.readUInt16LE(eocd + 10);
  if (count > MAX_ZIP_ENTRIES) throw new Error(`ZIP has too many entries (maximum ${MAX_ZIP_ENTRIES})`);
  let offset = buffer.readUInt32LE(eocd + 16); // central directory start

  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Corrupt ZIP: bad central directory');
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nameLength > 4096 || nextOffset > buffer.length) throw new Error('Corrupt ZIP: invalid central directory entry');
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.set(name, { method, compressedSize, uncompressedSize, localOffset });
    offset = nextOffset;
  }

  return {
    names: [...entries.keys()],
    read(name) {
      const entry = entries.get(name);
      if (!entry) return null;
      const { localOffset, method, compressedSize, uncompressedSize } = entry;
      if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new Error('Corrupt ZIP: bad local header');
      }
      const nameLength = buffer.readUInt16LE(localOffset + 26);
      const extraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + nameLength + extraLength;
      if (dataStart > buffer.length || compressedSize > buffer.length - dataStart) {
        throw new Error('Corrupt ZIP: entry extends beyond archive');
      }
      if (uncompressedSize > MAX_ZIP_ENTRY_BYTES) {
        throw new Error(`ZIP entry is too large after decompression (maximum ${MAX_ZIP_ENTRY_BYTES} bytes)`);
      }
      if (method === 0 && compressedSize > MAX_ZIP_ENTRY_BYTES) {
        throw new Error(`ZIP entry is too large (maximum ${MAX_ZIP_ENTRY_BYTES} bytes)`);
      }
      if (compressedSize > 0 && uncompressedSize / compressedSize > MAX_ZIP_EXPANSION_RATIO) {
        throw new Error(`ZIP entry expansion ratio exceeds ${MAX_ZIP_EXPANSION_RATIO}:1`);
      }
      const data = buffer.subarray(dataStart, dataStart + compressedSize);
      let output;
      if (method === 0) output = Buffer.from(data);
      else if (method === 8) output = zlib.inflateRawSync(data, { maxOutputLength: MAX_ZIP_ENTRY_BYTES });
      else throw new Error(`Unsupported ZIP compression method: ${method}`);
      if (output.length > MAX_ZIP_ENTRY_BYTES) throw new Error('ZIP entry is too large after decompression');
      if (output.length !== uncompressedSize) throw new Error('Corrupt ZIP: uncompressed size mismatch');
      return output;
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
