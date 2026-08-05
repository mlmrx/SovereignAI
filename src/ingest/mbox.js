/**
 * Zero-dependency mbox + RFC 822/MIME email parsing — the ingestion core of
 * Life Import rail #1. Same philosophy as the PDF/DOCX extractors (ADR-8):
 * Node built-ins only, best-effort by design, and honest about limits — an
 * unreadable part yields empty text rather than invented content.
 *
 * Scope: headers we act on (Message-ID, Subject, From, Date), the best text
 * body (text/plain preferred, text/html stripped as fallback), base64 and
 * quoted-printable transfer encodings, RFC 2047 encoded-word headers, and
 * charset decoding via TextDecoder with a latin1 fallback. Attachments are
 * deliberately ignored: this rail extracts signals, it does not archive mail.
 */

const MAX_MESSAGE_BYTES = 1024 * 1024; // headers + enough body for any receipt
const MAX_TEXT_CHARS = 64 * 1024;

/**
 * Stream an mbox (async iterable of Buffers — an fs.ReadStream, or [buffer])
 * and yield one raw message Buffer per mail. Messages larger than
 * maxMessageBytes are truncated (flagged via a trailing marker the email
 * parser understands) rather than buffered without bound. Input that does
 * not start with an mbox "From " separator is treated as a single RFC 822
 * message, so bare .eml files work too.
 */
export async function* iterateMboxMessages(source, { maxMessageBytes = MAX_MESSAGE_BYTES } = {}) {
  let carry = Buffer.alloc(0);
  let current = [];
  let currentBytes = 0;
  let truncated = false;
  // Decided by the very first line: 'mbox' when it is a From_ separator,
  // otherwise 'raw' — the whole input is one RFC 822 message (.eml).
  let mode = null;

  const flush = function* () {
    if (!current.length) return;
    const message = Buffer.concat(current);
    current = [];
    currentBytes = 0;
    const wasTruncated = truncated;
    truncated = false;
    if (message.length) yield { raw: message, truncated: wasTruncated };
  };

  const pushLine = (line) => {
    if (currentBytes + line.length > maxMessageBytes) {
      truncated = true;
      return;
    }
    current.push(line);
    currentBytes += line.length;
  };

  const handleLine = function* (line) {
    if (mode === null) mode = isFromSeparator(line) ? 'mbox' : 'raw';
    if (mode === 'mbox' && isFromSeparator(line)) yield* flush();
    else pushLine(line);
  };

  for await (const chunk of source) {
    carry = carry.length ? Buffer.concat([carry, chunk]) : Buffer.from(chunk);
    let start = 0;
    let newline;
    while ((newline = carry.indexOf(0x0a, start)) !== -1) {
      yield* handleLine(carry.subarray(start, newline + 1));
      start = newline + 1;
    }
    carry = Buffer.from(carry.subarray(start));
    // A stream with no (or very sparse) newlines must not accumulate without
    // bound — the per-message cap only fires once a line is terminated. Flush
    // an oversized unterminated remainder as a truncated line so RSS stays
    // bounded instead of OOMing on a newline-free file.
    if (carry.length > maxMessageBytes) {
      yield* handleLine(carry);
      carry = Buffer.alloc(0);
    }
  }
  if (carry.length) yield* handleLine(carry);
  yield* flush();
}

function isFromSeparator(line) {
  // mbox message separator: a line beginning exactly "From " (not ">From ").
  return line.length >= 5 && line[0] === 0x46 && line[1] === 0x72 && line[2] === 0x6f && line[3] === 0x6d && line[4] === 0x20;
}

/** Parse one raw RFC 822 message into the fields Life Import acts on. */
export function parseEmail(raw) {
  const split = splitHeadersFromBody(raw);
  const headers = parseHeaders(split.headerText);
  const from = parseAddress(decodeEncodedWords(headers.get('from') ?? ''));
  const date = parseMailDate(headers.get('date'));
  return {
    messageId: (headers.get('message-id') ?? '').trim().replace(/^<|>$/g, '') || null,
    subject: decodeEncodedWords(headers.get('subject') ?? '').trim(),
    from,
    date,
    text: extractText(headers, split.body).slice(0, MAX_TEXT_CHARS),
  };
}

function splitHeadersFromBody(raw) {
  // Structure (headers, boundaries) is ASCII; latin1 keeps byte<->index 1:1
  // so body parts can be sliced out of the original bytes for charset work.
  const latin1 = raw.toString('latin1');
  const match = latin1.match(/\r?\n\r?\n/);
  if (!match) return { headerText: latin1, body: Buffer.alloc(0) };
  const headerEnd = match.index;
  return {
    headerText: latin1.slice(0, headerEnd),
    body: raw.subarray(headerEnd + match[0].length),
  };
}

function parseHeaders(headerText) {
  const headers = new Map();
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
  }
  return headers;
}

/** RFC 2047: =?charset?B|Q?data?= words in Subject/From display names. */
export function decodeEncodedWords(value) {
  // Whitespace between adjacent encoded words is ignored per the RFC.
  const joined = value.replace(/\?=\s+=\?/g, '?==?');
  return joined.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, charset, encoding, data) => {
    try {
      const bytes =
        encoding.toLowerCase() === 'b'
          ? Buffer.from(data, 'base64')
          : decodeQuotedPrintable(data.replace(/_/g, ' '), { header: true });
      return decodeCharset(bytes, charset);
    } catch {
      return whole;
    }
  });
}

function parseAddress(rawValue) {
  // Cap the header value before matching: real addresses are short, and an
  // adversarial multi-kilobyte From header would drive the two adjacent
  // unbounded runs in these patterns into quadratic backtracking (ReDoS).
  // 998 is the RFC 2822 line-length limit. Also exclude '@' from the first
  // class so the boundary is unambiguous.
  const value = String(rawValue).slice(0, 998);
  const angled = value.match(/<([^<>@]+@[^<>]+)>/);
  if (angled) {
    const name = value.replace(angled[0], '').trim().replace(/^"|"$/g, '').trim();
    return { name, address: angled[1].trim().toLowerCase() };
  }
  const bare = value.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
  if (bare) {
    const comment = value.match(/\(([^)]*)\)/);
    return { name: comment?.[1]?.trim() ?? '', address: bare[0].toLowerCase() };
  }
  return { name: value.trim(), address: '' };
}

function parseMailDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Walk the MIME structure and return the best available plain text. */
function extractText(headers, body) {
  return extractEntityText(headers.get('content-type') ?? 'text/plain', headers.get('content-transfer-encoding') ?? '', body, 0);
}

function extractEntityText(contentTypeHeader, cte, body, depth) {
  if (depth > 6) return '';
  const { type, params } = parseContentType(contentTypeHeader);

  if (type.startsWith('multipart/')) {
    const boundary = params.boundary;
    if (!boundary) return '';
    const parts = splitMultipart(body, boundary);
    // Prefer text/plain anywhere, then text/html, then recurse into nested multiparts.
    for (const want of ['text/plain', 'text/html', 'multipart/']) {
      for (const part of parts) {
        const partType = parseContentType(part.headers.get('content-type') ?? 'text/plain').type;
        if (!partType.startsWith(want)) continue;
        const text = extractEntityText(
          part.headers.get('content-type') ?? 'text/plain',
          part.headers.get('content-transfer-encoding') ?? '',
          part.body,
          depth + 1
        );
        if (text.trim()) return text;
      }
    }
    return '';
  }

  if (!type.startsWith('text/')) return ''; // attachments are not our business
  const decoded = decodeTransferEncoding(body, cte);
  let text = decodeCharset(decoded, params.charset ?? 'utf-8');
  if (type === 'text/html') text = stripHtml(text);
  // mboxrd escaping: a body line ">From " arrived as escaped "From ".
  return text.replace(/^>(>*From )/gm, '$1');
}

function parseContentType(header) {
  const [typePart, ...paramParts] = header.split(';');
  const params = {};
  for (const part of paramParts) {
    const match = part.match(/([A-Za-z0-9-]+)\s*=\s*(?:"([^"]*)"|([^\s;]+))/);
    if (match) params[match[1].toLowerCase()] = match[2] ?? match[3];
  }
  return { type: typePart.trim().toLowerCase(), params };
}

function splitMultipart(body, boundary) {
  const latin1 = body.toString('latin1');
  const marker = `--${boundary}`;
  const parts = [];
  let cursor = latin1.indexOf(marker);
  while (cursor !== -1) {
    const lineEnd = latin1.indexOf('\n', cursor);
    if (lineEnd === -1) break;
    if (latin1.startsWith('--', cursor + marker.length)) break; // closing marker
    const next = latin1.indexOf(`\n${marker}`, lineEnd);
    const segmentEnd = next === -1 ? latin1.length : next;
    const segment = body.subarray(lineEnd + 1, segmentEnd);
    const split = splitHeadersFromBody(segment);
    parts.push({ headers: parseHeaders(split.headerText), body: split.body });
    if (next === -1) break;
    cursor = next + 1;
  }
  return parts;
}

function decodeTransferEncoding(body, cte) {
  const encoding = cte.trim().toLowerCase();
  if (encoding === 'base64') {
    return Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  }
  if (encoding === 'quoted-printable') {
    return decodeQuotedPrintable(body.toString('latin1'));
  }
  return body;
}

function decodeQuotedPrintable(text, { header = false } = {}) {
  const withoutSoftBreaks = header ? text : text.replace(/=\r?\n/g, '');
  const bytes = [];
  for (let index = 0; index < withoutSoftBreaks.length; index++) {
    const char = withoutSoftBreaks[index];
    if (char === '=' && /^[0-9A-Fa-f]{2}$/.test(withoutSoftBreaks.slice(index + 1, index + 3))) {
      bytes.push(parseInt(withoutSoftBreaks.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(char.charCodeAt(0) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function decodeCharset(bytes, charset) {
  const label = String(charset || 'utf-8').toLowerCase();
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return bytes.toString('latin1');
  }
}

function stripHtml(rawHtml) {
  // Bound the input: the style/script strip is a lazy match that rescans on
  // unterminated tags, and a decoded HTML part can be message-sized before the
  // caller's final slice. Capping here keeps every regex below fast.
  const html = rawHtml.length > MAX_TEXT_CHARS ? rawHtml.slice(0, MAX_TEXT_CHARS) : rawHtml;
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n')
    .trim();
}
