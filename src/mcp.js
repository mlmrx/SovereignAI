/**
 * MCP (Model Context Protocol) server over stdio — zero dependencies.
 *
 * Exposes the user's sovereign AI (memory, knowledge base, personas, chat)
 * as tools inside any MCP client: Claude Desktop, Claude Code, Codex CLI,
 * Cursor, Windsurf, Gemini CLI, and others.
 *
 *   { "mcpServers": { "sovereign": { "command": "node", "args": ["bin/sovereign.js", "mcp"] } } }
 */
import path from 'node:path';
import readline from 'node:readline';
import { loadConfig, VERSION } from './config.js';
import { openDb } from './db.js';
import { seedPersonas } from './personas.js';
import { chunkText } from './rag/chunker.js';
import { retrieve, embedTexts } from './rag/retriever.js';
import { handleChat } from './chat.js';
import { MAX_EXTRACTED_TEXT_BYTES } from './ingest/index.js';

const PROTOCOL_VERSION = '2025-03-26';

const TOOLS = [
  {
    name: 'ask_sovereign',
    description:
      "Ask the user's private sovereign AI a question. Its server and private data stay under the user's control; generation uses the configured model provider.",
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', maxLength: 200000, description: 'The question or request' },
        persona: { type: 'string', maxLength: 200, description: 'Optional persona name (e.g. Assistant, Engineer, Archivist)' },
      },
      required: ['message'],
    },
  },
  {
    name: 'search_knowledge',
    description: "Search the user's private local knowledge base and return the most relevant excerpts.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 20000 },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max results (default 6)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'add_knowledge',
    description: "Save a document into the user's private knowledge base (indexed locally for retrieval).",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: 512, description: 'Document name' },
        content: { type: 'string', maxLength: MAX_EXTRACTED_TEXT_BYTES, description: 'Full text content' },
      },
      required: ['name', 'content'],
    },
  },
  {
    name: 'add_memory',
    description: "Store a long-term memory note the user's sovereign AI should always keep in mind.",
    inputSchema: {
      type: 'object',
      properties: { content: { type: 'string', maxLength: 2000 } },
      required: ['content'],
    },
  },
  {
    name: 'list_memories',
    description: "List the sovereign AI's long-term memory notes.",
    inputSchema: { type: 'object', properties: {} },
  },
];

export async function runMcpServer(rootDir) {
  const config = loadConfig(rootDir);
  const store = openDb(path.join(rootDir, 'data'));
  seedPersonas(store);
  console.error(`SovereignAI MCP server v${VERSION} ready (data: ${path.join(rootDir, 'data')})`);

  const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let req;
    try {
      req = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (req.id === undefined) continue; // notification — nothing to answer

    try {
      const result = await dispatch(req, { store, config });
      write({ jsonrpc: '2.0', id: req.id, result });
    } catch (err) {
      write({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: err.message } });
    }
  }
}

async function dispatch(req, ctx) {
  switch (req.method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'sovereignai', version: VERSION },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      return callTool(req.params ?? {}, ctx);
    default:
      throw new Error(`Method not supported: ${req.method}`);
  }
}

async function callTool(params, { store, config }) {
  try {
    if (!isObject(params)) throw new Error('Tool call params must be an object');
    const name = requiredString(params, 'name', { maxChars: 100 });
    const args = params.arguments === undefined ? {} : params.arguments;
    const text = await runTool(name, args, { store, config });
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
}

async function runTool(name, args, { store, config }) {
  if (!isObject(args)) throw new Error('Tool arguments must be an object');
  switch (name) {
    case 'ask_sovereign': {
      const message = requiredString(args, 'message', { maxChars: 200_000, maxBytes: 800_000 });
      const personaName = optionalString(args, 'persona', { maxChars: 200 });
      const persona = personaName
        ? store.listPersonas().find((p) => p.name.toLowerCase() === personaName.toLowerCase())
        : null;
      if (personaName && !persona) throw new Error(`Persona not found: ${personaName}`);
      let answer = '';
      const sse = {
        send(event, data) {
          if (event === 'delta') answer += data.text;
          if (event === 'error') throw new Error(data.message);
        },
        end() {},
      };
      await handleChat({
        store,
        config,
        body: { message, personaId: persona?.id },
        sse,
      });
      return answer || '(no response)';
    }
    case 'search_knowledge': {
      const query = requiredString(args, 'query', { maxChars: 20_000, maxBytes: 80_000 });
      const limit = boundedInteger(args, 'limit', { fallback: 6, min: 1, max: 50 });
      const results = await retrieve({ store, config, query, limit });
      if (results.length === 0) return 'No matches in the knowledge base.';
      return results.map((r, i) => `[${i + 1}] ${r.document} (${r.method}, ${r.score})\n${r.content}`).join('\n\n');
    }
    case 'add_knowledge': {
      const name = requiredString(args, 'name', { maxChars: 512, maxBytes: 2048 });
      const content = requiredString(args, 'content', {
        maxChars: MAX_EXTRACTED_TEXT_BYTES,
        maxBytes: MAX_EXTRACTED_TEXT_BYTES,
        trimResult: false,
      });
      const pieces = chunkText(content);
      const vectors = await embedTexts(config, pieces);
      const chunks = pieces.map((content, i) => ({ content, embedding: vectors?.[i] ?? null }));
      const doc = store.addDocument({ name, size: content.length, chunks, embedded: Boolean(vectors) });
      return `Saved "${doc.name}" (${doc.chunk_count} chunks, ${doc.embedded ? 'semantic' : 'keyword'} index).`;
    }
    case 'add_memory': {
      const content = requiredString(args, 'content', { maxChars: 2000, maxBytes: 8000 });
      store.addMemory(content);
      return 'Remembered.';
    }
    case 'list_memories': {
      const memories = store.listMemories();
      return memories.length === 0 ? 'No memories yet.' : memories.map((m) => `- ${m.content}`).join('\n');
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function requiredString(object, key, { maxChars, maxBytes = Infinity, trimResult = true }) {
  const value = object[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required and must be a non-empty string`);
  if (value.length > maxChars || Buffer.byteLength(value, 'utf8') > maxBytes) throw new Error(`${key} is too large`);
  return trimResult ? value.trim() : value;
}

function optionalString(object, key, { maxChars }) {
  const value = object[key];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a non-empty string when provided`);
  if (value.length > maxChars) throw new Error(`${key} is too large`);
  return value.trim();
}

function boundedInteger(object, key, { fallback, min, max }) {
  const value = object[key];
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer from ${min} to ${max}`);
  return value;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
