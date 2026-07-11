# SovereignAI

**Your private AI command center.** Bring your preferred model, durable memory, and personal knowledge into one workspace you can inspect, move, and run yourself. Name it, shape its behavior, add your documents, and use Model Studio to create an inspectable, portable recipe for a named model on your configured Ollama endpoint. Zero runtime dependencies. MIT licensed.

```bash
node bin/sovereign.js start
# → open http://127.0.0.1:4321 — the setup wizard walks you through the rest
```

> **Status:** v0.3.0 — command center UI, source-aware chat, local/self-hosted Fine-Tuning Studio, hardened local security, and production-grade CLI/Docker workflows.

## Create your own AI in 5 simple steps

First run opens a guided wizard in the web UI:

1. **Name it** — "Mia", "Atlas", whatever feels right
2. **Pick its brain** — a local Ollama model, Claude with your API key, or any OpenAI-compatible endpoint. The wizard tells you exactly where prompts and context will be processed.
3. **Shape its personality** — describe it in your own words, tap trait chips (concise / warm / technical / challenger / teacher)
4. **Feed it your data** — drop in TXT, Markdown, **PDF**, and **DOCX** files; everything is indexed locally. Optionally let it learn about you automatically from conversations
5. **Make it real** — review the runtime, privacy path, knowledge, and memory choices before creation. On Ollama you can also **build it into a named model artifact** on the configured endpoint, e.g. `mia:latest`.

## Model Studio: build without giving up ownership

Model Studio turns the model build into data you control instead of a one-shot form. Save reusable recipes in your local SovereignAI SQLite database, tune the base model, system prompt, generation parameters, prompt template, license, quantization, and seed messages, then build or revise the artifact whenever you choose. Every recipe has a readable Ollama Modelfile representation and is included in full-workspace JSON export/import, so it can be inspected, versioned, copied, or restored without SovereignAI.

The ownership boundary is explicit:

- **The recipe is yours here** — it lives with your personas, conversations, memory, and knowledge in the SovereignAI home you selected.
- **The artifact is yours there** — a build calls `/api/create` on the Ollama endpoint you configured. A local endpoint keeps build inputs and the resulting artifact on that machine; a remote endpoint receives the recipe inputs and stores the artifact remotely.
- **There is no hidden training claim** — Model Studio packages a base model with configurable inference behavior and metadata. It does not update the source model's weights or perform fine-tuning. Actual LoRA/QLoRA training is a separate, explicitly consented Fine-Tuning Studio workflow.

SovereignAI does not upload recipes, workspace data, or model artifacts to a project-owned cloud. Remote processing happens only when you select a remote provider or configure a non-local Ollama endpoint. Portable exports contain the recipe and the ingredients needed to render its Modelfile—not Ollama weight blobs. Your control of the recipe and artifact does not replace the license of the selected base model; review and follow those terms before use or redistribution. Quantization is available only when the source and selected format are eligible (Ollama supports it for FP16/FP32 sources).

## Fine-Tuning Studio: actual training on infrastructure you control

Fine-Tuning Studio guides a user through selecting conversations, recording source and destination consent, reviewing/redacting every example, freezing leakage-protected train/evaluation JSONL, and submitting a real LoRA or QLoRA job to a compatible local or self-hosted trainer. Trainer status is authoritative—SovereignAI never simulates training progress or success. Deployment requires evaluation evidence or an explicit documented skip, a trainer-attested Ollama tag and digest, and a matching model at the configured Ollama endpoint.

Training is disabled by default and has no hosted fallback. The workflow never calls an OpenAI fine-tuning API; OpenAI-compatible chat remains an independent optional provider configured with the user's own key. See the [guided fine-tuning design](docs/FINE_TUNING.md) and [trainer v1 protocol](integrations/trainer/README.md).

## Useful from the first conversation

- **Command center** — see provider readiness, workspace counts, recent conversations, and context-aware workflows at a glance.
- **Context you can trust** — every chat shows its active persona, model, local/remote data path, memory state, and knowledge state.
- **Sources, not mystery** — knowledge-grounded answers include an expandable drawer with the exact retrieved excerpts, documents, methods, and scores.
- **Retrieval preview** — search your local knowledge index directly to see what the model will receive before asking it anything.
- **Memory you control** — add, search, edit, or forget durable context; automatic extraction is an explicit opt-in.
- **Weights you control** — curate immutable datasets and run actual LoRA/QLoRA training through a trainer you operate, with consent, holdout, lineage, and deployment gates.
- **Responsive and accessible** — full mobile navigation, keyboard-visible actions, labeled controls, live generation status, and reduced-motion support.
- **Race-safe streaming** — stop generation, switch views safely, copy answers or code, and keep a persona consistent for each conversation.

## Why sovereign

- **Own the runtime** — one Node process on your hardware. **Zero npm dependencies**: no supply chain, auditable, works offline. Docker image available.
- **Own the brain** — Ollama models, OpenAI-compatible servers (vLLM, llama.cpp, LM Studio, Groq…), or BYO-key Anthropic; switchable per persona. Model Studio saves portable recipes and builds custom named artifacts on the Ollama endpoint you control.
- **Own the memory** — conversations, long-term memory (manual notes + optional automatic fact extraction), and a document knowledge base in local SQLite. Hybrid retrieval: semantic embeddings when available, BM25 keyword always — fully offline capable.
- **Own the data** — PDF/DOCX/text ingestion runs entirely locally (even the parsers are dependency-free). Portable JSON backups cover personas, chats, memory, knowledge, model recipes, and fine-tuning project history; provider/trainer settings and secrets are deliberately omitted and reconfigured separately.
- **Share on your terms** — `sovereign start --lan` exposes it on your LAN or tailnet behind an auto-generated bearer token. The `#token=` fragment keeps the secret out of HTTP request URLs and access logs. Default is localhost-only.

## Install

**Single binary (no Node, no install):** download `sovereign-v*` for Windows,
macOS, or Linux from [Releases](https://github.com/mlmrx/SovereignAI/releases),
make it executable, and run it — the Node runtime, app, and web UI are all
inside one file. See [operations](docs/OPERATIONS.md#single-binary-installs)
for the one-time SmartScreen/Gatekeeper confirmation unsigned binaries need.

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

Releases: tagging `v*` triggers CI that packages the `.vsix`, browser zip, JetBrains plugin zip, and single-file executables for Windows/macOS/Linux into a GitHub Release and publishes the Docker image to GHCR. Marketplace publishing activates when `VSCE_PAT` / `OVSX_PAT` repo secrets are added; every store artifact ships icons and listing copy per the [store submission guide](docs/STORE_SUBMISSION.md).

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
  training/             canonical dataset snapshots · self-hosted trainer protocol client
  ingest/               zero-dep file ingestion: ZIP reader → DOCX · PDF · text
  rag/                  chunker · BM25 · hybrid retriever
public/                 responsive command center + wizard + guided Fine-Tuning Studio
integrations/           mcp · vscode · jetbrains · browser · chatgpt · trainer protocol
scripts/                install.ps1 · install.sh · build-sea.mjs (single binary) · make-icons.mjs
Dockerfile / compose    container distribution (ghcr.io image via CI)
test/                   node:test suite
```

Decision records: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## API (localhost)

`POST /api/chat` (SSE) · `POST /api/ask` (JSON) · CRUD and build routes under `/api/model-recipes` · `POST /api/create-model` (legacy direct Ollama build) · `POST /api/documents` (text or base64 PDF/DOCX) · `GET /api/search?q=` · CRUD for `personas` / `conversations` / `memories` · `GET /api/export` / `POST /api/import` · `GET /api/providers` · `GET /api/models` · `GET/PUT /api/config`

Fine-tuning routes live under `/api/training`: project/source/example curation, immutable dataset locking/export, trainer capabilities, run submit/refresh/cancel, evaluation decisions, and digest-gated Ollama persona assignment. Dataset bytes are sent only by the run-submission route after endpoint-bound consent.

Model recipe routes are `GET/POST /api/model-recipes`, `GET/PUT/DELETE /api/model-recipes/:id`, and `POST /api/model-recipes/:id/build`. A build response includes the generated Modelfile and ownership metadata so clients can show where the artifact was created.

Security: binds `127.0.0.1` by default. When `authToken` or `SOVEREIGN_TOKEN` is configured, **every** API request—including loopback and tunnel traffic—requires the bearer token. `--lan` generates one and prints a `#token=` browser URL; the browser stores it locally and sends it only as an authorization header. Tokenless localhost mode also rejects cross-origin browser writes, unsafe host headers, and non-JSON mutations.

Plain HTTP does not encrypt bearer tokens, prompts, or retrieved context. Use it only on a trusted local network or encrypted overlay/tailnet; terminate HTTPS before exposing SovereignAI anywhere else.

## Development

```bash
npm test                    # node:test — nothing to install, there are no dependencies
node scripts/build-sea.mjs  # build + smoke-test the single binary for this platform
```

The suite includes 100+ core, UI-contract, integration, API, security, config, provider, training, ingestion, CLI, and Compose checks. Docker image builds remain covered by CI.

## Roadmap

- [x] Core platform: gateway, memory, RAG, personas, portability
- [x] Integrations: MCP, VS Code, browser, ChatGPT Actions
- [x] Setup wizard (guided first-run in the web UI)
- [x] PDF/DOCX ingestion, auto memory extraction
- [x] JetBrains plugin; release pipeline for store publishing
- [x] Install scripts, Docker image, LAN/tailnet mode
- [ ] Store listings live — everything is submission-ready ([guide](docs/STORE_SUBMISSION.md)); the remaining step is marketplace accounts (VS Code, Chrome, AMO, JetBrains)
- [x] Guided local/self-hosted LoRA/QLoRA workflow with reviewed JSONL export
- [x] Mobile-friendly command center, visible citations, editable memory, and safe streaming controls
- [x] Single-binary builds (Node SEA) for Windows, macOS, and Linux

## License

[MIT](LICENSE) — free to use, modify, and distribute. Your AI should be yours; so should the code that runs it.
