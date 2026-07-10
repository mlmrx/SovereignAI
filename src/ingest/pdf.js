import zlib from 'node:zlib';

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
  const streamRe = /stream\r?\n/g;
  let match;
  while ((match = streamRe.exec(raw)) !== null) {
    const start = match.index + match[0].length;
    const end = raw.indexOf('endstream', start);
    if (end === -1) break;
    const dictStart = raw.lastIndexOf('<<', match.index);
    const dict = dictStart === -1 ? '' : raw.slice(dictStart, match.index);
    streamRe.lastIndex = end;

    let content = buffer.subarray(start, end);
    if (/FlateDecode/.test(dict)) {
      try {
        content = zlib.inflateSync(content);
      } catch {
        try {
          content = zlib.inflateRawSync(content);
        } catch {
          continue; // not inflatable (image, etc.)
        }
      }
    } else if (/(DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode)/.test(dict)) {
      continue; // image data
    }
    const text = extractTextOps(content.toString('latin1'));
    if (text) texts.push(text);
  }

  const result = texts.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const printable = result.replace(/[^\x20-\x7E\xA0-￿\n\t]/g, '');
  if (!result || printable.length / Math.max(result.length, 1) < 0.7) {
    throw new Error('Could not extract readable text from this PDF (it may be scanned or use unsupported font encodings)');
  }
  return printable;
}

function extractTextOps(stream) {
  if (!/BT/.test(stream)) return '';
  let out = '';
  // string ops: (..) Tj | (..) ' | (..) " | [ .. ] TJ ; line moves: Td TD T* start new lines
  const opRe = /\(((?:\\.|[^\\()])*)\)\s*(Tj|'|")|\[((?:\\.|[^\]])*)\]\s*TJ|(T\*|T[dD])(?![A-Za-z])/g;
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
