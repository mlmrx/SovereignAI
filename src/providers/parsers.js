/** Streaming body parsers shared by providers. `body` is a fetch response body (async iterable). */

/** Parse an SSE stream into { event, data } objects (data JSON-parsed when possible). */
export async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  let dataLines = [];
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line === '') {
        if (dataLines.length > 0) {
          const raw = dataLines.join('\n');
          yield { event, data: tryParse(raw), raw };
        }
        event = 'message';
        dataLines = [];
      } else if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
      // comment lines (":...") and other fields are ignored
    }
  }
  if (dataLines.length > 0) {
    const raw = dataLines.join('\n');
    yield { event, data: tryParse(raw), raw };
  }
}

/** Parse a newline-delimited JSON stream (Ollama's format). */
export async function* ndjsonLines(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield JSON.parse(line);
    }
  }
  const rest = buffer.trim();
  if (rest) yield JSON.parse(rest);
}

function tryParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Throw a readable error for a non-OK fetch response. */
export async function ensureOk(response, providerLabel) {
  if (response.ok) return;
  let detail = '';
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text);
      detail = json.error?.message ?? json.error ?? text;
    } catch {
      detail = text;
    }
  } catch {
    /* ignore */
  }
  const message = typeof detail === 'string' ? detail.slice(0, 500) : JSON.stringify(detail).slice(0, 500);
  throw new Error(`${providerLabel} error (HTTP ${response.status})${message ? ': ' + message : ''}`);
}
