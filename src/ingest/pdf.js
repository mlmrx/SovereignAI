import zlib from 'node:zlib';

export const MAX_PDF_STREAM_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_TOTAL_STREAM_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_STREAM_COUNT = 4096;
export const MAX_PDF_DICT_BYTES = 64 * 1024;

/**
 * Best-effort PDF text extraction (zero deps).
 * Handles uncompressed and FlateDecode content streams and the common text
 * operators (Tj, TJ, ', "). CID/embedded-encoding fonts may not round-trip —
 * we detect garbage output and fail loudly rather than index noise.
 */
export function extractPdf(buffer) {
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('Not a PDF file');
  const raw = buffer.toString('latin1');

  const texts = [];
  let processedBytes = 0;
  let extractedBytes = 0;
  let streamCount = 0;
  const streamRe = /stream\r?\n/g;
  let match;
  while ((match = streamRe.exec(raw)) !== null) {
    streamCount++;
    if (streamCount > MAX_PDF_STREAM_COUNT) throw new Error('PDF contains too many streams');
    const start = match.index + match[0].length;
    const end = raw.indexOf('endstream', start);
    if (end === -1) break;
    const windowStart = Math.max(0, match.index - MAX_PDF_DICT_BYTES);
    const beforeStream = raw.slice(windowStart, match.index);
    const dictStart = beforeStream.lastIndexOf('<<');
    const dict = dictStart === -1 ? '' : beforeStream.slice(dictStart);
    streamRe.lastIndex = end;

    let content = buffer.subarray(start, end);
    if (/FlateDecode/.test(dict)) {
      const remaining = Math.min(MAX_PDF_STREAM_BYTES, MAX_PDF_TOTAL_STREAM_BYTES - processedBytes);
      if (remaining <= 0) throw new Error('PDF contains too much decompressed stream data');
      content = inflateBounded(content, remaining);
      if (!content) continue; // not inflatable (image, etc.)
    } else if (/(DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode)/.test(dict)) {
      continue; // image data
    }
    if (content.length > MAX_PDF_STREAM_BYTES) throw new Error('PDF stream is too large after decompression');
    processedBytes += content.length;
    if (processedBytes > MAX_PDF_TOTAL_STREAM_BYTES) throw new Error('PDF contains too much decompressed stream data');
    const text = extractTextOps(content.toString('latin1'));
    if (text) {
      extractedBytes += Buffer.byteLength(text);
      if (extractedBytes > MAX_PDF_STREAM_BYTES) throw new Error('PDF extracted text is too large');
      texts.push(text);
    }
  }

  const result = texts.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const printable = result.replace(/[^\x20-\x7E\xA0-￿\n\t]/g, '');
  if (!result || printable.length / Math.max(result.length, 1) < 0.7) {
    throw new Error('Could not extract readable text from this PDF (it may be scanned or use unsupported font encodings)');
  }
  return printable;
}

function inflateBounded(content, maxOutputLength) {
  try {
    return zlib.inflateSync(content, { maxOutputLength });
  } catch (err) {
    if (isOutputLimit(err)) throw new Error(`PDF stream is too large after decompression (maximum ${maxOutputLength} bytes)`);
    try {
      return zlib.inflateRawSync(content, { maxOutputLength });
    } catch (rawErr) {
      if (isOutputLimit(rawErr)) throw new Error(`PDF stream is too large after decompression (maximum ${maxOutputLength} bytes)`);
      return null;
    }
  }
}

function isOutputLimit(err) {
  return err?.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|larger than/i.test(err?.message ?? '');
}

function extractTextOps(stream) {
  if (!/BT/.test(stream)) return '';
  let out = '';
  // string ops: (..) Tj | (..) ' | (..) " | [ .. ] TJ ; line moves: Td TD T* start new lines
  // The TJ-array class MUST exclude backslash so it is disjoint from the
  // `\\.` escape alternative — otherwise a run of backslashes with no closing
  // `]` partitions exponentially and hangs on a tiny crafted PDF (ReDoS).
  const opRe = /\(((?:\\.|[^\\()])*)\)\s*(Tj|'|")|\[((?:\\.|[^\\\]])*)\]\s*TJ|(T\*|T[dD])(?![A-Za-z])/g;
  let m;
  while ((m = opRe.exec(stream)) !== null) {
    if (m[4]) {
      if (out && !out.endsWith('\n')) out += '\n';
    } else if (m[3] !== undefined) {
      for (const part of m[3].matchAll(/\(((?:\\.|[^\\()])*)\)/g)) out += decodePdfString(part[1]);
    } else if (m[1] !== undefined) {
      if ((m[2] === "'" || m[2] === '"') && out && !out.endsWith('\n')) out += '\n';
      out += decodePdfString(m[1]);
    }
  }
  return out.trim();
}

function decodePdfString(s) {
  return s.replace(/\\(\d{1,3}|.)/g, (_, esc) => {
    if (/^\d/.test(esc)) return String.fromCharCode(parseInt(esc, 8));
    switch (esc) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'b': return '\b';
      case 'f': return '\f';
      default: return esc; // \( \) \\ and line continuations
    }
  });
}
