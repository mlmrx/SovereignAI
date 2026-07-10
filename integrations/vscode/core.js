'use strict';

const DEFAULT_SERVER_URL = 'http://127.0.0.1:4321';

class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function normalizeServerUrl(value) {
  const raw = String(value || DEFAULT_SERVER_URL).trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Enter a valid server URL, such as http://127.0.0.1:4321.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('The server URL must use http:// or https://.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Do not put credentials in the server URL. Save the bearer token with the token command.');
  }
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new Error('Enter only the server origin, without a path, query, or fragment.');
  }
  return parsed.origin;
}

function tokenStorageKey(serverUrl) {
  const origin = normalizeServerUrl(serverUrl);
  return `sovereignai.authToken.${Buffer.from(origin).toString('base64url')}`;
}

function normalizeToken(value) {
  const token = String(value || '').trim();
  if (!token) throw new Error('The bearer token cannot be empty.');
  if (/\r|\n/.test(token)) throw new Error('The bearer token cannot contain line breaks.');
  return token;
}

async function responseError(response) {
  let message = '';
  try {
    const text = await response.text();
    if (text) {
      try {
        const payload = JSON.parse(text);
        if (typeof payload?.error === 'string') message = payload.error;
        else if (typeof payload?.message === 'string') message = payload.message;
      } catch {
        message = text.replace(/\s+/g, ' ').trim().slice(0, 500);
      }
    }
  } catch {
    // Preserve the status-based fallback when the response body is unreadable.
  }

  const status = Number(response.status) || 0;
  if (!message) message = response.statusText || (status ? `HTTP ${status}` : 'Request failed');
  if (status === 401) message = `${message}. Save the server bearer token with “SovereignAI: Set Bearer Token”.`;
  if (status === 403) message = `${message}. Check the server URL and its remote-access token configuration.`;
  return new ApiError(message, status);
}

async function* parseSse(body) {
  if (!body || typeof body.getReader !== 'function') throw new Error('The server returned no response stream.');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      buffer = buffer.replace(/\r\n/g, '\n');
      // Preserve a trailing CR between chunks so a split CRLF is not mistaken
      // for two newlines and an early event boundary.
      if (done) buffer = buffer.replace(/\r/g, '\n');
      else {
        const trailingCr = buffer.endsWith('\r');
        const stable = trailingCr ? buffer.slice(0, -1) : buffer;
        buffer = stable.replace(/\r/g, '\n') + (trailingCr ? '\r' : '');
      }
      if (done && buffer.trim() && !buffer.endsWith('\n\n')) buffer += '\n\n';

      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let event = 'message';
        const dataLines = [];
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) continue;
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
        if (!dataLines.length) continue;
        const raw = dataLines.join('\n');
        try {
          yield { event, data: JSON.parse(raw) };
        } catch {
          yield { event: 'protocol-error', data: { message: 'The server sent a malformed streaming event.' } };
        }
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock?.();
  }
}

class ChatSession {
  constructor() {
    this.conversationId = null;
    this.current = null;
    this.sequence = 0;
  }

  begin(controller = new AbortController()) {
    if (this.current) return null;
    const run = { id: ++this.sequence, controller };
    this.current = run;
    return run;
  }

  isCurrent(run) {
    return Boolean(run && this.current === run);
  }

  setConversation(run, conversationId) {
    if (this.isCurrent(run) && typeof conversationId === 'string' && conversationId) {
      this.conversationId = conversationId;
      return true;
    }
    return false;
  }

  finish(run) {
    if (!this.isCurrent(run)) return false;
    this.current = null;
    return true;
  }

  stop() {
    if (!this.current) return false;
    this.current.controller.abort();
    return true;
  }

  reset() {
    const current = this.current;
    this.current = null;
    this.conversationId = null;
    this.sequence += 1;
    current?.controller.abort();
  }
}

function isLoopbackUrl(serverUrl) {
  const hostname = new URL(normalizeServerUrl(serverUrl)).hostname.toLowerCase();
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
}

module.exports = {
  ApiError,
  ChatSession,
  DEFAULT_SERVER_URL,
  isLoopbackUrl,
  normalizeServerUrl,
  normalizeToken,
  parseSse,
  responseError,
  tokenStorageKey,
};
