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

const PROTOCOL_VERSION = '2025-03-26';

const TOOLS = [
  {
    name: 'ask_sovereign',
    description:
      "Ask the user's private sovereign AI a question. It answers with the user's chosen persona, long-term memory, and private knowledge base — running on the user's own machine.",
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The question or request' },
        persona: { type: 'string', description: 'Optional persona name (e.g. Assistant, Engineer, Archivist)' },
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
        query: { type: 'string' },
        limit: { type: 'integer', description: 'Max results (default 6)' },
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
        name: { type: 'string', description: 'Document name' },
        content: { type: 'string', description: 'Full text content' },
      },
      required: ['name', 'content'],
    },
  },
  {
    name: 'add_memory',
    description: "Store a long-term memory note the user's sovereign AI should always keep in mind.",
    inputSchema: {
      type: 'object',
      properties: { content: { type: 'string' } },
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

async function callTool({ name, arguments: args = {} }, { store, config }) {
  try {
    const text = await runTool(name, args, { store, config });
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
}

async function runTool(name, args, { store, config }) {
  switch (name) {
    case 'ask_sovereign': {
      const persona = args.persona
        ? store.listPersonas().find((p) => p.name.toLowerCase() === String(args.persona).toLowerCase())
        : null;
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
        body: { message: String(args.message), personaId: persona?.id },
        sse,
      });
      return answer || '(no response)';
    }
    case 'search_knowledge': {
      const results = await retrieve({ store, config, query: String(args.query), limit: args.limit ?? 6 });
      if (results.length === 0) return 'No matches in the knowledge base.';
      return results.map((r, i) => `[${i + 1}] ${r.document} (${r.method}, ${r.score})\n${r.content}`).join('\n\n');
    }
    case 'add_knowledge': {
      const pieces = chunkText(String(args.content));
      const vectors = await embedTexts(config, pieces);
      const chunks = pieces.map((content, i) => ({ content, embedding: vectors?.[i] ?? null }));
      const doc = store.addDocument({ name: String(args.name), size: String(args.content).length, chunks, embedded: Boolean(vectors) });
      return `Saved "${doc.name}" (${doc.chunk_count} chunks, ${doc.embedded ? 'semantic' : 'keyword'} index).`;
    }
    case 'add_memory': {
      store.addMemory(String(args.content));
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
