# SovereignAI

**Your private AI command center.** Bring your preferred model, durable memory, and personal knowledge into one workspace you can inspect, move, and run yourself. Name it, shape its behavior, add your documents, and optionally bake a named model on your configured Ollama endpoint. Zero runtime dependencies. MIT licensed.

```bash
node bin/sovereign.js start
# → open http://127.0.0.1:4321 — the setup wizard walks you through the rest
```

> **Status:** v0.3.0 — command center UI, source-aware chat, hardened local security, and production-grade CLI/Docker workflows.

## Create your own AI in 5 simple steps

First run opens a guided wizard in the web UI:

1. **Name it** — "Mia", "Atlas", whatever feels right
2. **Pick its brain** — a local Ollama model, Claude with your API key, or any OpenAI-compatible endpoint. The wizard tells you exactly where prompts and context will be processed.
3. **Shape its personality** — describe it in your own words, tap trait chips (concise / warm / technical / challenger / teacher)
4. **Feed it your data** — drop in TXT, Markdown, **PDF**, and **DOCX** files; everything is indexed locally. Optionally let it learn about you automatically from conversations
5. **Make it real** — review the runtime, privacy path, knowledge, and memory choices before creation. On Ollama you can also **bake it into a named model** on the configured endpoint, e.g. `mia:latest`.

## Useful from the first conversation

- **Command center** — see provider readiness, workspace counts, recent conversations, and context-aware workflows at a glance.
- **Context you can trust** — every chat shows its active persona, model, local/remote data path, memory state, and knowledge state.
- **Sources, not mystery** — knowledge-grounded answers include an expandable drawer with the exact retrieved excerpts, documents, methods, and scores.
- **Retrieval preview** — search your local knowledge index directly to see what the model will receive before asking it anything.
- **Memory you control** — add, search, edit, or forget durable context; automatic extraction is an explicit opt-in.
- **Responsive and accessible** — full mobile navigation, keyboard-visible actions, labeled controls, live generation status, and reduced-motion support.
- **Race-safe streaming** — stop generation, switch views safely, copy answers or code, and keep a persona consistent for each conversation.

## Why sovereign

- **Own the runtime** — one Node process on your hardware. **Zero npm dependencies**: no supply chain, auditable, works offline. Docker image available.
- **Own the brain** — Ollama models, OpenAI-compatible servers (vLLM, llama.cpp, LM Studio, Groq…), or BYO-key Anthropic; switchable per persona. Bake custom named models on the Ollama endpoint you control.
- **Own the memory** — conversations, long-term memory (manual notes + optional automatic fact extraction), and a document knowledge base in local SQLite. Hybrid retrieval: semantic embeddings when available, BM25 keyword always — fully offline capable.
- **Own the data** — PDF/DOCX/text ingestion runs entirely locally (even the parsers are dependency-free). Portable JSON backups cover personas, chats, memory, and knowledge; provider settings and secrets are reconfigured separately.
- **Share on your terms** — `sovereign start --lan` exposes it on your LAN or tailnet behind an auto-generated bearer token. The `#token=` fragment keeps the secret out of HTTP request URLs and access logs. Default is localhost-only.

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
# macOS/Linux: keep and display the token before starting
export SOVEREIGN_TOKEN="$(openssl rand -hex 24)"
echo "Save this URL: http://localhost:4321/#token=$SOVEREIGN_TOKEN"
docker compose --profile ollama up -d
```

```powershell
# Windows PowerShell
$env:SOVEREIGN_TOKEN = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
Write-Host "Save this URL: http://localhost:4321/#token=$env:SOVEREIGN_TOKEN"
docker compose --profile ollama up -d
```

Reuse that token for future container recreations (or store `SOVEREIGN_TOKEN=...` in the Git-ignored `.env` file). To use Ollama already running on the Docker host, omit `--profile ollama` and set `OLLAMA_BASE_URL=http://host.docker.internal:11434` before `docker compose up -d`.

**From source:** Node 22.5+, `git clone`, `node bin/sovereign.js start`. Local models: [Ollama](https://ollama.com) + `ollama pull llama3.1` (and `ollama pull nomic-embed-text` for semantic search).

Installed launchers keep one stable AI home in `%LOCALAPPDATA%\SovereignAI` on Windows or `~/.sovereignai` on macOS/Linux, regardless of the current directory. Set `SOVEREIGN_HOME` explicitly when you want a separate project-specific instance. See [operations and troubleshooting](docs/OPERATIONS.md).

Upgrading from v0.2 requires one state-location check before the first v0.3 launch; Docker users should also preserve the old container-layer config. Follow the [v0.2 migration guide](docs/OPERATIONS.md#upgrading-from-v02).

```
sovereign start [--lan]    # run the server (LAN/tailnet mode with --lan)
sovereign init             # write a starter config file
sovereign doctor           # diagnose home, config, database, providers, and models
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
bin/sovereign.js        CLI (start [--lan] · init · doctor · mcp · export · import)
src/
  server.js             HTTP server, REST API, SSE, static UI, bearer auth
  chat.js               orchestration: history + memory + RAG → stream
  mcp.js                MCP server (stdio JSON-RPC, zero deps)
  memory-extract.js     automatic long-term memory extraction (opt-in)
  db.js                 SQLite storage (node:sqlite, built into Node 22)
  providers/            gateway: ollama (chat/embed/create) · openai-compat · anthropic
  ingest/               zero-dep file ingestion: ZIP reader → DOCX · PDF · text
  rag/                  chunker · BM25 · hybrid retriever
public/                 responsive command center + accessible first-run wizard
integrations/           mcp · vscode (.vsix) · jetbrains · browser (MV3) · chatgpt
scripts/                install.ps1 · install.sh
Dockerfile / compose    container distribution (ghcr.io image via CI)
test/                   node:test suite
```

Decision records: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## API (localhost)

`POST /api/chat` (SSE) · `POST /api/ask` (JSON) · `POST /api/create-model` (bake a named Ollama model) · `POST /api/documents` (text or base64 PDF/DOCX) · `GET /api/search?q=` · CRUD for `personas` / `conversations` / `memories` · `GET /api/export` / `POST /api/import` · `GET /api/providers` · `GET /api/models` · `GET/PUT /api/config`

Security: binds `127.0.0.1` by default. When `authToken` or `SOVEREIGN_TOKEN` is configured, **every** API request—including loopback and tunnel traffic—requires the bearer token. `--lan` generates one and prints a `#token=` browser URL; the browser stores it locally and sends it only as an authorization header. Tokenless localhost mode also rejects cross-origin browser writes, unsafe host headers, and non-JSON mutations.

Plain HTTP does not encrypt bearer tokens, prompts, or retrieved context. Use it only on a trusted local network or encrypted overlay/tailnet; terminate HTTPS before exposing SovereignAI anywhere else.

## Development

```bash
npm test    # node:test — nothing to install, there are no dependencies
```

The suite includes 85+ core, UI-contract, integration, API, security, config, provider, ingestion, CLI, and Compose checks. Docker image builds remain covered by CI.

## Roadmap

- [x] Core platform: gateway, memory, RAG, personas, portability
- [x] Integrations: MCP, VS Code, browser, ChatGPT Actions
- [x] Setup wizard (guided first-run in the web UI)
- [x] PDF/DOCX ingestion, auto memory extraction
- [x] JetBrains plugin; release pipeline for store publishing
- [x] Install scripts, Docker image, LAN/tailnet mode
- [ ] Store listings live (needs marketplace accounts: VS Code, Chrome, AMO, JetBrains)
- [ ] Fine-tuning exports (training-ready JSONL from your conversations)
- [x] Mobile-friendly command center, visible citations, editable memory, and safe streaming controls
- [ ] Single-binary builds (Node SEA)

## License

[MIT](LICENSE) — free to use, modify, and distribute. Your AI should be yours; so should the code that runs it.
