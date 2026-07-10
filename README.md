# ⬡ SovereignAI

**Create your own sovereign AI** — an assistant you actually own: your models, your memory, your knowledge, your machine. Zero runtime dependencies. One command to start.

```bash
node bin/sovereign.js start
# → Web UI at http://127.0.0.1:4321
```

> **Status:** v0.1.0 — working end-to-end. Server, web UI, CLI, MCP server, VS Code extension, and browser extension all functional today.

## Why

Most people's "AI" is a rented seat on someone else's infrastructure: their models, their memory, their telemetry, their rules. SovereignAI flips the ownership:

- **Own the runtime** — a single Node process on hardware you control. **Zero npm dependencies**: no supply chain, fully auditable, works offline.
- **Own the brain** — local models via **Ollama**, any **OpenAI-compatible** server (vLLM, llama.cpp, LM Studio, Groq…), or BYO-key **Anthropic** — switch freely per persona.
- **Own the memory** — conversations, long-term memory notes, and a document knowledge base in a local SQLite file. Hybrid retrieval (semantic embeddings when available, BM25 keyword always — works fully offline).
- **Shape the behavior** — personas with their own system prompts, models, memory and knowledge switches. Three sensible defaults included (Assistant, Engineer, Archivist).
- **No lock-in** — one-click export of *everything* to portable JSON. Import it anywhere.

## Quickstart

Requirements: [Node.js 22.5+](https://nodejs.org). For local models: [Ollama](https://ollama.com) with any chat model (`ollama pull llama3.1`).

```bash
git clone https://github.com/mlmrx/SovereignAI
cd SovereignAI
node bin/sovereign.js start
```

Open http://127.0.0.1:4321 → Settings → pick your default model → chat.

Optional semantic knowledge search: `ollama pull nomic-embed-text` (without it, retrieval runs in keyword mode — still fully functional).

```
sovereign start            # run the server
sovereign init             # write a starter config file
sovereign mcp              # MCP server (stdio) for Claude/Codex/Cursor/Gemini CLI
sovereign export [file]    # export all data to JSON
sovereign import <file>    # restore from an export
```

## Your AI, everywhere

The platform is the substrate; `integrations/` carries it into every tool you use:

| Surface | What you get | Where |
|---|---|---|
| **MCP server** | Your AI's memory + knowledge inside **Claude Desktop, Claude Code, Codex CLI, Cursor, Windsurf, Gemini CLI** | [`integrations/mcp/`](integrations/mcp/README.md) |
| **VS Code extension** (`.vsix`) | Streaming chat panel, ask-about-selection, save-code-to-knowledge. Works in Cursor/Windsurf/VSCodium too | [`integrations/vscode/`](integrations/vscode/README.md) |
| **Browser extension** (MV3) | Popup chat + right-click "save to my AI's knowledge / memory" (Chrome, Edge, Brave; Firefox note included) | [`integrations/browser/`](integrations/browser/README.md) |
| **ChatGPT Custom GPT** | Actions schema so ChatGPT can query *your* AI (needs a tunnel — OpenAI must reach you) | [`integrations/chatgpt/`](integrations/chatgpt/README.md) |

## Architecture

```
bin/sovereign.js        CLI (start · init · mcp · export · import)
src/
  server.js             HTTP server, REST API, SSE, static UI, auth
  chat.js               chat orchestration: history + memory + RAG → stream
  mcp.js                MCP server (stdio JSON-RPC, zero deps)
  config.js             config + env overrides + secret redaction
  db.js                 SQLite storage (node:sqlite — built into Node 22)
  providers/            model gateway: ollama · openai-compat · anthropic
  rag/                  chunker · BM25 · hybrid retriever
public/                 web UI (vanilla JS, no build step, no telemetry)
integrations/           vscode (.vsix) · browser (MV3) · mcp · chatgpt
test/                   node:test suite (21 tests)
```

Details and decision records: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## API (localhost)

`POST /api/chat` (SSE stream) · `POST /api/ask` (simple JSON) · `GET /api/search?q=` · CRUD for `personas`, `conversations`, `memories`, `documents` · `GET /api/export` / `POST /api/import` · `GET /api/providers` · `GET /api/models` · `GET/PUT /api/config`

Security model: binds to `127.0.0.1` by default. Remote access requires setting `authToken` in `sovereign.config.json` (Bearer auth); without a token, non-local requests are refused.

## Development

```bash
npm test    # node:test, no dependencies to install — there are none
```

## Roadmap

- [x] Core platform: gateway, memory, RAG, personas, portability
- [x] Integrations: MCP, VS Code, browser, ChatGPT Actions
- [ ] Setup wizard (guided first-run in the web UI)
- [ ] PDF/DOCX ingestion, auto memory extraction
- [ ] JetBrains plugin; signed store releases of the extensions
- [ ] Packaged installers (single binary), Docker image, LAN/tailnet mode

## License

[MIT](LICENSE) — free to use, modify, and distribute. Your AI should be yours; so should the code that runs it.
