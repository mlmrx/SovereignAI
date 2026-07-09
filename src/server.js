import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, redactConfig, mergeConfigUpdate, VERSION } from './config.js';
import { openDb } from './db.js';
import { providers, getProvider, providerStatus } from './providers/index.js';
import { seedPersonas } from './personas.js';
import { chunkText } from './rag/chunker.js';
import { retrieve, embedTexts } from './rag/retriever.js';
import { handleChat } from './chat.js';
import { readJsonBody, sendJson, sseStart, HttpError } from './util.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function createApp(rootDir) {
  const config = loadConfig(rootDir);
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
    counts: {
      personas: store.listPersonas().length,
      conversations: store.listConversations().length,
      documents: store.listDocuments().length,
      memories: store.listMemories().length,
    },
    defaults: config.defaults,
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
    const merged = mergeConfigUpdate(config, body);
    Object.assign(config, merged);
    saveConfig(rootDir, config);
    return redactConfig(config);
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
  route('DELETE', '/api/conversations/:id', async ({ params }) => {
    store.deleteConversation(params.id);
    return { ok: true };
  });

  // ---- memories ----
  route('GET', '/api/memories', async () => store.listMemories());
  route('POST', '/api/memories', async ({ body }) => {
    if (!body.content) throw new HttpError(400, 'content is required');
    return store.addMemory(String(body.content));
  });
  route('DELETE', '/api/memories/:id', async ({ params }) => {
    store.deleteMemory(params.id);
    return { ok: true };
  });

  // ---- knowledge base ----
  route('GET', '/api/documents', async () => store.listDocuments());
  route('POST', '/api/documents', async ({ body }) => {
    if (!body.name || typeof body.content !== 'string' || !body.content.trim()) {
      throw new HttpError(400, 'name and content are required');
    }
    const pieces = chunkText(body.content);
    const vectors = await embedTexts(config, pieces);
    const chunks = pieces.map((content, i) => ({ content, embedding: vectors?.[i] ?? null }));
    return store.addDocument({ name: body.name, size: body.content.length, chunks, embedded: Boolean(vectors) });
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
    return { answer, conversationId: meta?.conversationId ?? null, persona: meta?.persona ?? null, model: meta?.model ?? null, usage };
  });

  // ---- data portability ----
  route('GET', '/api/export', async () => ({
    sovereignai: VERSION,
    exportedAt: new Date().toISOString(),
    config: redactConfig(config),
    data: store.exportAll(),
  }));
  route('POST', '/api/import', async ({ body }) => {
    if (!body.data) throw new HttpError(400, 'Invalid export file: missing data');
    return { imported: store.importAll(body.data) };
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      const segments = url.pathname.split('/').filter(Boolean);

      if (url.pathname.startsWith('/api/')) {
        if (!authorized(req, config)) {
          return sendJson(res, 401, { error: 'Unauthorized: bearer token required for remote access' });
        }

        // chat is special-cased: it streams SSE
        if (req.method === 'POST' && url.pathname === '/api/chat') {
          const body = await readJsonBody(req);
          const sse = sseStart(res);
          const abort = new AbortController();
          req.on('close', () => abort.abort());
          try {
            await handleChat({ store, config, body, sse, signal: abort.signal });
          } catch (err) {
            sse.send('error', { message: err.message });
            sse.end();
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

/** Local requests are always allowed; remote requests need the bearer token (when configured). */
function authorized(req, config) {
  const remote = req.socket.remoteAddress ?? '';
  const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (isLocal) return true;
  if (!config.authToken) return false; // never expose without a token
  return req.headers.authorization === `Bearer ${config.authToken}`;
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

export function startServer(rootDir, { host, port } = {}) {
  const app = createApp(rootDir);
  const listenHost = host ?? app.config.host;
  const listenPort = port ?? app.config.port;
  return new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(listenPort, listenHost, () => resolve({ ...app, host: listenHost, port: listenPort }));
  });
}
