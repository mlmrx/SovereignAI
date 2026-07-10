# ⬡ SovereignAI

**Create your own AI on your own data — in minutes.** Name it, give it a personality, feed it your documents, and (optionally) bake it into a named local model that's yours forever. Your models, your memory, your machine. Zero runtime dependencies. MIT licensed.

```bash
node bin/sovereign.js start
# → open http://127.0.0.1:4321 — the setup wizard walks you through the rest
```

> **Status:** v0.2.0 — everything below is implemented and working.

## Create your own AI in 5 simple steps

First run opens a guided wizard in the web UI:

1. **Name it** — "Mia", "Atlas", whatever feels right
2. **Pick its brain** — a local Ollama model (fully private), Claude with your API key, or any OpenAI-compatible server
3. **Shape its personality** — describe it in your own words, tap trait chips (concise / warm / technical / challenger / teacher)
4. **Feed it your data** — drop in TXT, Markdown, **PDF**, and **DOCX** files; everything is indexed locally. Optionally let it learn about you automatically from conversations
5. **Make it real** — one click creates your AI. On Ollama you can also **bake it into a named local model** — it shows up in `ollama list` as *your* model, e.g. `mia:latest`

## Why sovereign

- **Own the runtime** — one Node process on your hardware. **Zero npm dependencies**: no supply chain, auditable, works offline. Docker image available.
- **Own the brain** — Ollama local models, OpenAI-compatible servers (vLLM, llama.cpp, LM Studio, Groq…), or BYO-key Anthropic; switchable per persona. Bake custom named models from any Ollama base.
- **Own the memory** — conversations, long-term memory (manual notes + optional automatic fact extraction), and a document knowledge base in local SQLite. Hybrid retrieval: semantic embeddings when available, BM25 keyword always — fully offline capable.
- **Own the data** — PDF/DOCX/text ingestion runs entirely locally (even the parsers are dependency-free). One-click export of everything to portable JSON.
- **Share on your terms** — `sovereign start --lan` exposes it on your LAN or tailnet behind an auto-generated bearer token; open the printed `?token=` URL from any device. Default is localhost-only.

## Install

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/mlmrx/SovereignAI/main/scripts/install.ps1 | iex
```

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/mlmrx/SovereignAI/main/scripts/install.sh | sh
```

**Docker:**
```bash
SOVEREIGN_TOKEN=$(openssl rand -hex 24) docker compose up -d      # + host Ollama
docker compose --profile ollama up -d                             # or containerized Ollama
```

**From source:** Node 22.5+, `git clone`, `node bin/sovereign.js start`. Local models: [Ollama](https://ollama.com) + `ollama pull llama3.1` (and `ollama pull nomic-embed-text` for semantic search).

```
sovereign start [--lan]    # run the server (LAN/tailnet mode with --lan)
sovereign init             # write a starter config file
sovereign mcp              # MCP server (stdio) for Claude/Codex/Cursor/Gemini CLI
sovereign export [file]    # export all data to JSON
sovereign import <file>    # restore from an export
```

## Your AI, everywhere

| Surface | What you get | Where |
|---|---|---|
| **MCP server** | Your AI's memory + knowledge inside **Claude Desktop, Claude Code, Codex CLI, Cursor, Windsurf, Gemini CLI** | [`integrations/mcp/`](integrations/mcp/README.md) |
| **VS Code extension** (`.vsix`) | Streaming chat panel, ask-about-selection, save-code-to-knowledge (also Cursor/Windsurf/VSCodium) | [`integrations/vscode/`](integrations/vscode/README.md) |
| **JetBrains plugin** | Tool-window chat + editor actions for IntelliJ, PyCharm, WebStorm, GoLand… | [`integrations/jetbrains/`](integrations/jetbrains/README.md) |
| **Browser extension** (MV3) | Popup chat + right-click "save to my AI's knowledge / memory" | [`integrations/browser/`](integrations/browser/README.md) |
| **ChatGPT Custom GPT** | Actions schema so ChatGPT can query *your* AI (needs a tunnel) | [`integrations/chatgpt/`](integrations/chatgpt/README.md) |

Releases: tagging `v*` triggers CI that packages the `.vsix`, browser zip, and JetBrains plugin zip into a GitHub Release and publishes the Docker image to GHCR. Marketplace publishing activates when `VSCE_PAT` / `OVSX_PAT` repo secrets are added (see [`.github/workflows/release.yml`](.github/workflows/release.yml)).

## Architecture

```
bin/sovereign.js        CLI (start [--lan] · init · mcp · export · import)
src/
  server.js             HTTP server, REST API, SSE, static UI, bearer auth
  chat.js               orchestration: history + memory + RAG → stream
  mcp.js                MCP server (stdio JSON-RPC, zero deps)
  memory-extract.js     automatic long-term memory extraction (opt-in)
  db.js                 SQLite storage (node:sqlite, built into Node 22)
  providers/            gateway: ollama (chat/embed/create) · openai-compat · anthropic
  ingest/               zero-dep file ingestion: ZIP reader → DOCX · PDF · text
  rag/                  chunker · BM25 · hybrid retriever
public/                 web UI + first-run wizard (vanilla JS, no build, no telemetry)
integrations/           mcp · vscode (.vsix) · jetbrains · browser (MV3) · chatgpt
scripts/                install.ps1 · install.sh
Dockerfile / compose    container distribution (ghcr.io image via CI)
test/                   node:test suite
```

Decision records: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## API (localhost)

`POST /api/chat` (SSE) · `POST /api/ask` (JSON) · `POST /api/create-model` (bake a named Ollama model) · `POST /api/documents` (text or base64 PDF/DOCX) · `GET /api/search?q=` · CRUD for `personas` / `conversations` / `memories` · `GET /api/export` / `POST /api/import` · `GET /api/providers` · `GET /api/models` · `GET/PUT /api/config`

Security: binds `127.0.0.1` by default. Remote access requires the bearer token (`--lan` generates and prints it; browsers remember it via the `?token=` URL).

## Development

```bash
npm test    # node:test — nothing to install, there are no dependencies
```

## Roadmap

- [x] Core platform: gateway, memory, RAG, personas, portability
- [x] Integrations: MCP, VS Code, browser, ChatGPT Actions
- [x] Setup wizard (guided first-run in the web UI)
- [x] PDF/DOCX ingestion, auto memory extraction
- [x] JetBrains plugin; release pipeline for store publishing
- [x] Install scripts, Docker image, LAN/tailnet mode
- [ ] Store listings live (needs marketplace accounts: VS Code, Chrome, AMO, JetBrains)
- [ ] Fine-tuning exports (training-ready JSONL from your conversations)
- [ ] Single-binary builds (Node SEA), mobile-friendly UI

## License

[MIT](LICENSE) — free to use, modify, and distribute. Your AI should be yours; so should the code that runs it.
