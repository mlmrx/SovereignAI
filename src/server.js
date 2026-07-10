import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig,
  saveConfig,
  redactConfig,
  mergeConfigUpdate,
  withoutEnvironmentManagedFields,
  scrubPersistedEnvironmentSecrets,
  ConfigValidationError,
  VERSION,
} from './config.js';
import { ImportValidationError, openDb } from './db.js';
import { providers, getProvider, providerStatus } from './providers/index.js';
import { seedPersonas, shouldReplaceSeedPersonas } from './personas.js';
import { chunkText } from './rag/chunker.js';
import { retrieve, embedTexts } from './rag/retriever.js';
import { extractText } from './ingest/index.js';
import { handleChat } from './chat.js';
import { applySecurityHeaders, isJsonRequest, readJsonBody, sendJson, sseStart, HttpError } from './util.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function createApp(rootDir, { env = process.env } = {}) {
  const config = loadConfig(rootDir, { env });
  const store = openDb(path.join(rootDir, 'data'));
  seedPersonas(store);
  const startedAt = Date.now();

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern: pattern.split('/').filter(Boolean), handler });

  // ---- status & providers ----
  route('GET', '/api/status', async () => ({
    name: config.name,
    version: VERSION,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    counts: store.getCounts(),
    defaults: config.defaults,
    setupComplete: Boolean(config.setupComplete),
  }));

  route('GET', '/api/providers', async () => providerStatus(config));

  route('GET', '/api/models', async ({ query }) => {
    if (query.provider) {
      const provider = getProvider(query.provider);
      const cfg = config.providers[query.provider];
      if (!provider.isConfigured(cfg)) throw new HttpError(400, `Provider "${query.provider}" is not configured`);
      return { provider: query.provider, models: await provider.listModels(cfg) };
    }
    const all = [];
    for (const provider of Object.values(providers)) {
      const cfg = config.providers[provider.id];
      if (!provider.isConfigured(cfg)) continue;
      try {
        all.push({ provider: provider.id, models: await provider.listModels(cfg) });
      } catch {
        all.push({ provider: provider.id, models: [], error: 'unreachable' });
      }
    }
    return all;
  });

  // ---- config ----
  route('GET', '/api/config', async () => redactConfig(config));
  route('PUT', '/api/config', async ({ body }) => {
    try {
      const persistedBase = scrubPersistedEnvironmentSecrets(loadConfig(rootDir, { env: {} }), env);
      const diskUpdate = withoutEnvironmentManagedFields(body, env);
      const merged = mergeConfigUpdate(persistedBase, diskUpdate);
      saveConfig(rootDir, merged);
      const effective = loadConfig(rootDir, { env });
      for (const key of Object.keys(config)) delete config[key];
      Object.assign(config, effective);
      return redactConfig(config);
    } catch (err) {
      if (err instanceof ConfigValidationError) throw new HttpError(400, err.message);
      throw err;
    }
  });

  // ---- personas ----
  route('GET', '/api/personas', async () => store.listPersonas());
  route('POST', '/api/personas', async ({ body }) => {
    if (!body.name || !body.system_prompt) throw new HttpError(400, 'name and system_prompt are required');
    return store.createPersona(body);
  });
  route('PUT', '/api/personas/:id', async ({ params, body }) => {
    const updated = store.updatePersona(params.id, body);
    if (!updated) throw new HttpError(404, 'Persona not found');
    return updated;
  });
  route('DELETE', '/api/personas/:id', async ({ params }) => {
    store.deletePersona(params.id);
    return { ok: true };
  });

  // ---- conversations ----
  route('GET', '/api/conversations', async () => store.listConversations());
  route('GET', '/api/conversations/:id', async ({ params }) => {
    const conversation = store.getConversation(params.id);
    if (!conversation) throw new HttpError(404, 'Conversation not found');
    return { ...conversation, messages: store.listMessages(params.id) };
  });
  const renameConversation = async ({ params, body }) => {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) throw new HttpError(400, 'title is required');
    if (title.length > 200) throw new HttpError(400, 'title must be at most 200 characters');
    const updated = store.renameConversation(params.id, title);
    if (!updated) throw new HttpError(404, 'Conversation not found');
    return updated;
  };
  route('PUT', '/api/conversations/:id', renameConversation);
  route('PATCH', '/api/conversations/:id', renameConversation);
  route('DELETE', '/api/conversations/:id', async ({ params }) => {
    store.deleteConversation(params.id);
    return { ok: true };
  });

  // ---- memories ----
  route('GET', '/api/memories', async () => store.listMemories());
  route('POST', '/api/memories', async ({ body }) => {
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!content) throw new HttpError(400, 'content is required');
    if (content.length > 2000) throw new HttpError(400, 'content must be at most 2000 characters');
    return store.addMemory(content);
  });
  const updateMemory = async ({ params, body }) => {
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!content) throw new HttpError(400, 'content is required');
    if (content.length > 2000) throw new HttpError(400, 'content must be at most 2000 characters');
    const updated = store.updateMemory(params.id, content);
    if (!updated) throw new HttpError(404, 'Memory not found');
    return updated;
  };
  route('PUT', '/api/memories/:id', updateMemory);
  route('PATCH', '/api/memories/:id', updateMemory);
  route('DELETE', '/api/memories/:id', async ({ params }) => {
    store.deleteMemory(params.id);
    return { ok: true };
  });

  // ---- knowledge base ----
  route('GET', '/api/documents', async () => store.listDocuments());
  route('POST', '/api/documents', async ({ body }) => {
    if (!body.name) throw new HttpError(400, 'name is required');
    let text;
    if (typeof body.contentBase64 === 'string' && body.contentBase64) {
      text = extractText(body.name, Buffer.from(body.contentBase64, 'base64'));
    } else if (typeof body.content === 'string' && body.content.trim()) {
      text = extractText(body.name, Buffer.from(body.content, 'utf8'));
    } else {
      throw new HttpError(400, 'content or contentBase64 is required');
    }
    if (!text.trim()) throw new HttpError(422, `${body.name}: no extractable text`);
    const pieces = chunkText(text);
    const vectors = await embedTexts(config, pieces);
    const chunks = pieces.map((content, i) => ({ content, embedding: vectors?.[i] ?? null }));
    return store.addDocument({ name: body.name, size: text.length, chunks, embedded: Boolean(vectors) });
  });

  // ---- bake a named model on the configured Ollama endpoint ----
  route('POST', '/api/create-model', async ({ body }) => {
    const { name, base, system } = body;
    if (!name || !base || !system) throw new HttpError(400, 'name, base and system are required');
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new HttpError(400, 'Model name: letters, digits, dots, dashes only');
    const cfg = config.providers.ollama;
    if (!providers.ollama.isConfigured(cfg)) throw new HttpError(400, 'Ollama is not configured');
    return providers.ollama.createModel(cfg, { name, base, system });
  });
  route('DELETE', '/api/documents/:id', async ({ params }) => {
    store.deleteDocument(params.id);
    return { ok: true };
  });
  route('GET', '/api/search', async ({ query }) => {
    if (!query.q) throw new HttpError(400, 'q is required');
    return retrieve({ store, config, query: query.q });
  });

  // ---- simple ask (non-streaming; for integrations like ChatGPT Actions) ----
  route('POST', '/api/ask', async ({ body }) => {
    const persona = body.persona
      ? store.listPersonas().find((p) => p.name.toLowerCase() === String(body.persona).toLowerCase())
      : null;
    let answer = '';
    let meta = null;
    let usage = null;
    const sse = {
      send(event, data) {
        if (event === 'delta') answer += data.text;
        if (event === 'meta') meta = data;
        if (event === 'done') usage = data.usage;
        if (event === 'error') throw new HttpError(502, data.message);
      },
      end() {},
    };
    await handleChat({
      store,
      config,
      body: { message: body.message, personaId: persona?.id ?? body.personaId, conversationId: body.conversationId },
      sse,
    });
    return {
      answer,
      conversationId: meta?.conversationId ?? null,
      persona: meta?.persona ?? null,
      model: meta?.model ?? null,
      sources: meta?.sources ?? [],
      usage,
    };
  });

  // ---- data portability ----
  route('GET', '/api/export', async () => ({
    sovereignai: VERSION,
    exportedAt: new Date().toISOString(),
    data: store.exportAll(),
  }));
  route('POST', '/api/import', async ({ body }) => {
    if (!body.data) throw new HttpError(400, 'Invalid export file: missing data');
    try {
      const replacePersonas = shouldReplaceSeedPersonas(store, body.data);
      return { imported: store.importAll(body.data, { replacePersonas }) };
    } catch (err) {
      if (err instanceof ImportValidationError) throw new HttpError(400, err.message);
      throw err;
    }
  });

  const server = http.createServer(async (req, res) => {
    try {
      applySecurityHeaders(res);
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      const segments = url.pathname.split('/').filter(Boolean);

      if (url.pathname.startsWith('/api/')) {
        const accessError = apiAccessError(req, config);
        if (accessError) {
          return sendJson(res, accessError.status, { error: accessError.message });
        }
        if (['POST', 'PUT', 'PATCH'].includes(req.method) && !isJsonRequest(req)) {
          return sendJson(res, 415, { error: 'Content-Type must be application/json' });
        }

        // chat is special-cased: it streams SSE
        if (req.method === 'POST' && url.pathname === '/api/chat') {
          const body = await readJsonBody(req);
          const sse = sseStart(res);
          const abort = new AbortController();
          const onDisconnect = () => {
            if (!res.writableEnded) abort.abort(new Error('Client disconnected'));
          };
          res.once('close', onDisconnect);
          try {
            await handleChat({ store, config, body, sse, signal: abort.signal });
          } catch (err) {
            if (!abort.signal.aborted && !res.destroyed) {
              sse.send('error', { message: err.message });
              sse.end();
            }
          } finally {
            res.off('close', onDisconnect);
          }
          return;
        }

        for (const r of routes) {
          if (r.method !== req.method) continue;
          const params = matchRoute(r.pattern, segments);
          if (!params) continue;
          const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJsonBody(req) : {};
          const result = await r.handler({ params, body, query: Object.fromEntries(url.searchParams) });
          return sendJson(res, 200, result);
        }
        return sendJson(res, 404, { error: `No route: ${req.method} ${url.pathname}` });
      }

      serveStatic(url.pathname, res);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) sendJson(res, status, { error: err.message });
      else res.end();
    }
  });

  return { server, config, store };
}

function matchRoute(pattern, segments) {
  if (pattern.length !== segments.length) return null;
  const params = {};
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i].startsWith(':')) params[pattern[i].slice(1)] = decodeURIComponent(segments[i]);
    else if (pattern[i] !== segments[i]) return null;
  }
  return params;
}

function apiAccessError(req, config) {
  if (config.authToken) {
    if (matchesBearer(req.headers.authorization, config.authToken)) return null;
    return { status: 401, message: 'Unauthorized: valid bearer token required' };
  }

  const remote = req.socket.remoteAddress ?? '';
  const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (!isLocal) return { status: 403, message: 'Remote API access requires a configured bearer token' };
  if (!trustedLoopbackHost(req.headers.host)) return { status: 403, message: 'Untrusted Host header' };
  if (!safeBrowserOrigin(req.headers.origin, req.headers.host)) return { status: 403, message: 'Cross-origin API access denied' };
  return null;
}

function matchesBearer(header, token) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function trustedLoopbackHost(host) {
  if (typeof host !== 'string' || !host) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname.toLowerCase().replace(/\.$/, '');
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
  } catch {
    return false;
  }
}

function safeBrowserOrigin(origin, host) {
  if (origin === undefined) return true; // CLI, IDE, MCP bridge, and other non-browser clients
  if (typeof origin !== 'string' || typeof host !== 'string') return false;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol === 'chrome-extension:' || parsed.protocol === 'moz-extension:') return true;
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function serveStatic(pathname, res) {
  let rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    // SPA fallback
    const index = path.join(PUBLIC_DIR, 'index.html');
    res.writeHead(200, { 'content-type': MIME['.html'] });
    res.end(fs.readFileSync(index));
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  res.end(fs.readFileSync(file));
}

export function startServer(rootDir, { host, port, env = process.env } = {}) {
  const app = createApp(rootDir, { env });
  const listenHost = host ?? app.config.host;
  const listenPort = port ?? app.config.port;
  return new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(listenPort, listenHost, () => resolve({ ...app, host: listenHost, port: listenPort }));
  });
}
