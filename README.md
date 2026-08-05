# SovereignAI

**Your private AI command center.** Bring your preferred model, durable memory, and personal knowledge into one workspace you can inspect, move, and run yourself.

> **Why this exists:** [You are the most fragmented database on earth](docs/WHY.md) — and the reassembled you is only safe on hardware you control.
> **What "sovereign" means here, audited:** [The Sovereignty Ledger](docs/SOVEREIGNTY.md) — every layer, its status, its compromise, your exit. Name it, shape its behavior, add your documents, and use Model Studio to create an inspectable, portable recipe for a named model on your configured Ollama endpoint. Zero runtime dependencies. Fair-source licensed (FSL-1.1-MIT) — every release becomes MIT two years after it ships.

```bash
node bin/sovereign.js start
# → open ru — the setup wizard walks you through the rest
# → then open /guide.html — an interactive guide that checks itself off
#   against your real workspace as you learn
```

> **Status:** v0.5.0 — portability both ways, honestly recorded: memory provenance, checksummed (and optionally encrypted) export archives with a [documented open format](docs/EXPORT_FORMAT.md), a pasteable Personal Context Portfolio, and opt-in memory distillation from imported chat history. Plus everything before it: command center UI, source-aware chat, Fine-Tuning Studio, BYOC rails, chat-history import, single binaries.

## Create your own AI in 5 simple steps

First run opens a guided wizard in the web UI:

1. **Name it** — "Mia", "Atlas", whatever feels right
2. **Pick its brain** — a local Ollama model, Claude with your API key, or any OpenAI-compatible endpoint. The wizard tells you exactly where prompts and context will be processed.
3. **Shape its personality** — describe it in your own words, tap trait chips (concise / warm / technical / challenger / teacher)
4. **Feed it your data** — drop in TXT, Markdown, **PDF**, and **DOCX** files; everything is indexed locally. Optionally let it learn about you automatically from conversations
5. **Make it real** — review the runtime, privacy path, knowledge, and memory choices before creation. On Ollama you can also **build it into a named model artifact** on the configured endpoint, e.g. `mia:latest`.

## Model Studio: build without giving up ownership

Model Studio turns the model build into data you control instead of a one-shot form. Save reusable recipes in your local SovereignAI SQLite database, tune the base model, system prompt, generation parameters, prompt template, license, quantization, and seed messages, then build or revise the artifact whenever you choose. Every recipe has a readable Ollama Modelfile representation and is included in full-workspace JSON export/import, so it can be inspected, versioned, copied, or restored without SovereignAI. The base model field accepts any open-weight source Ollama can resolve, including Hugging Face GGUF repos (`hf.co/<owner>/<repo>[:<quant>]`) — an in-app search browses public GGUF repos and their quantization variants to help fill it in, without downloading anything until you build.

The ownership boundary is explicit:

- **The recipe is yours here** — it lives with your personas, conversations, memory, and knowledge in the SovereignAI home you selected.
- **The artifact is yours there** — a build calls `/api/create` on the Ollama endpoint you configured. A local endpoint keeps build inputs and the resulting artifact on that machine; a remote endpoint receives the recipe inputs and stores the artifact remotely.
- **There is no hidden training claim** — Model Studio packages a base model with configurable inference behavior and metadata. It does not update the source model's weights or perform fine-tuning. Actual LoRA/QLoRA training is a separate, explicitly consented Fine-Tuning Studio workflow.

SovereignAI does not upload recipes, workspace data, or model artifacts to a project-owned cloud. Remote processing happens only when you select a remote provider or configure a non-local Ollama endpoint. Portable exports contain the recipe and the ingredients needed to render its Modelfile—not Ollama weight blobs. Your control of the recipe and artifact does not replace the license of the selected base model; review and follow those terms before use or redistribution. Quantization is available only when the source and selected format are eligible (Ollama supports it for FP16/FP32 sources).

## Fine-Tuning Studio: actual training on infrastructure you control

Fine-Tuning Studio guides a user through selecting conversations, recording source and destination consent, reviewing/redacting every example, freezing leakage-protected train/evaluation JSONL, and submitting a real LoRA or QLoRA job to a compatible local or self-hosted trainer. Trainer status is authoritative—SovereignAI never simulates training progress or success. Deployment requires evaluation evidence or an explicit documented skip, a trainer-attested Ollama tag and digest, and a matching model at the configured Ollama endpoint.

Training is disabled by default and has no hosted fallback. The workflow never calls an OpenAI fine-tuning API; OpenAI-compatible chat remains an independent optional provider configured with the user's own key. See the [guided fine-tuning design](docs/FINE_TUNING.md) and [trainer v1 protocol](integrations/trainer/README.md).

## Useful from the first conversation

- **The first five minutes** — after setup, drop your ChatGPT or Claude export into the **Arrival** door: it's parsed on your machine, your AI distills who you are from it in front of you, and greets you knowing your name, projects, and preferences — every remembered fact naming the conversation it came from. No export handy? Skip it; the door stays open in the Mind view.
- **The Mind view** — the new landing surface: a control room for the context layer you own. What your AI knows (counted by provenance: added by you, learned from chats, distilled from imports), the latest entries with receipts, imported-history state with one-click distillation, and every outbound door — portfolio, MCP, editors, verified export.
- **Life signals (rail #1: email)** — `sovereign import-email your-takeout.mbox` scans your mail archive on your machine (no model calls, bodies never stored, no logins — you bring the export) for receipts, subscriptions, renewals, and bookings. The Mind view then answers the questions no single vendor can: **what am I paying for monthly** (subscription audit with estimated total) and **what renews in the next 90 days** (renewals radar). Every record keeps the evidence it was built from. [How it works and what it refuses to do](docs/LIFE_IMPORT.md).
- **The Sovereign Path (`/guide.html`)** — an interactive, self-verifying guide: ten waypoints from first launch to full ownership, each with a live check against your own workspace's API. It turns terracotta when your instance can prove you've been there — progress as evidence, not decoration.
- **Command center** — see provider readiness, workspace counts, recent conversations, and context-aware workflows at a glance.
- **Context you can trust** — every chat shows its active persona, model, local/remote data path, memory state, and knowledge state.
- **Sources, not mystery** — knowledge-grounded answers include an expandable drawer with the exact retrieved excerpts, documents, methods, and scores.
- **Retrieval preview** — search your local knowledge index directly to see what the model will receive before asking it anything.
- **Memory you control** — add, search, edit, or forget durable context; automatic extraction is an explicit opt-in.
- **Weights you control** — curate immutable datasets and run actual LoRA/QLoRA training through a trainer you operate, with consent, holdout, lineage, and deployment gates.
- **Responsive and accessible** — full mobile navigation, keyboard-visible actions, labeled controls, live generation status, and reduced-motion support.
- **XBrain (experimental)** — a reimagined three-surface interface: `/xbrain.html` (the Mind Field: a full-viewport constellation where every hexagonal cell is a real memory or document — the cells your AI truly recalls ignite and thread into the answer while it streams, with voice/recall/trace faces and select-to-keep consented memory), `/xbrain-ledger.html` (the Memory Ledger: every kept memory as an auditable line you can amend or strike), and `/xbrain-atlas.html` (the Knowledge Atlas: probe your documents with real retrieval scores before asking anything). Design brief: [`docs/XBRAIN_DESIGN_BRIEF.md`](docs/XBRAIN_DESIGN_BRIEF.md).
- **Race-safe streaming** — stop generation, switch views safely, copy answers or code, and keep a persona consistent for each conversation.

## Why sovereign

- **Own the runtime** — one Node process on your hardware. **Zero npm dependencies**: no supply chain, auditable, works offline. Docker image available.
- **Own the brain** — Ollama models, OpenAI-compatible servers (vLLM, llama.cpp, LM Studio, Groq…), or BYO-key Anthropic; switchable per persona. Model Studio saves portable recipes and builds custom named artifacts on the Ollama endpoint you control.
- **Own the memory** — conversations, long-term memory (manual notes + optional automatic fact extraction), and a document knowledge base in local SQLite. Hybrid retrieval: semantic embeddings when available, BM25 keyword always — fully offline capable.
- **Own the data** — PDF/DOCX/text ingestion runs entirely locally (even the parsers are dependency-free). Portable JSON backups cover personas, chats, memory, knowledge, model recipes, and fine-tuning project history; provider/trainer settings and secrets are deliberately omitted and reconfigured separately. Archives are checksummed and verifiable (`sovereign verify`), optionally encrypted with a passphrase only you hold, and the format is [openly documented](docs/EXPORT_FORMAT.md) so your data outlives this software.
- **Own the provenance** — every memory records how it entered the system (added by you, auto-extracted, or distilled from imported history), from which conversation, and when it was last edited. Records that predate tracking say so instead of pretending. The Personal Context Portfolio (`sovereign portfolio`) turns that layer into one markdown document you can paste into any other AI tool — the export door platforms don't build.
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
sovereign export [file] [--encrypt]   # checksummed JSON archive (optionally AES-256-GCM encrypted)
sovereign import <file>    # restore from an export (verifies checksums, decrypts if needed)
sovereign verify <file>    # check an archive against its manifest without importing
sovereign portfolio [file] # your Personal Context Portfolio as pasteable markdown
sovereign import-chat <file> [--from platform] [--distill]   # bring in chat history from another AI platform
sovereign import-email <file.mbox> [--dry-run]   # Life Import rail #1: receipts, subscriptions, renewals, bookings
sovereign distill          # sweep imported conversations for durable memories (opt-in, one model call each)
sovereign byoc <action>    # deploy + manage instances on a Docker host YOU own, over SSH
```

**Bring your own cloud:** `sovereign byoc deploy --host you@your-box` provisions a hardened instance on any Linux machine with SSH and Docker — a VPS, a homelab, on-prem. Your data stays on your host; the deploy tooling keeps only connection metadata and a token _hash_, and revoking its SSH key severs it completely. Don't already have a box? `sovereign byoc gpu deploy <runpod|vastai|lambda>` rents a GPU instance and deploys onto it — **unverified against live provider infrastructure, test with the cheapest GPU type first**; see [the BYOC connector](docs/BYOC_SSH_CONNECTOR.md) for exactly what that means and what it costs.

**Ride the open-weights wave:** when a release is too big for your box — the frontier-scale MoE class — `sovereign byoc gpu serve runpod --gpu-type <id> --model <huggingface-id>` rents a GPU running vLLM's OpenAI-compatible server with those exact weights and wires it in as a provider (`--wire`). One command to serve, one to destroy, billing disclosed at every step. Meanwhile every answer from a local model now carries a **weight-digest receipt** (which exact weights replied), and the Hugging Face browser shows each repo's **declared license at the point of choice** — open weights are not automatically open license.

**Bring your history with you:** `sovereign import-chat` (CLI, or Settings → Data & privacy in the web UI) parses ChatGPT's and Claude's official export ZIPs directly — built with real confidence, since both are well-documented, stable formats. Imported history starts as archive prose; add `--distill` (or run `sovereign distill` later) to opt into sweeping it for durable memories with your configured model — one call per conversation, idempotent, every distilled memory tagged with its source. Gemini's Google Takeout export is supported experimentally (prompts only; see [the chat import guide](docs/CHAT_IMPORT.md)). Everything else — Grok, Kimi, GLM, DeepSeek, Qwen, or any platform without a dedicated parser — goes through a documented generic JSON format instead of a guessed-at one. Parsing is entirely local; re-running the same file is safe and never duplicates history.

## Your AI, everywhere

| Surface                         | What you get                                                                                                 | Where                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| **MCP server**                  | Your AI's memory + knowledge inside **Claude Desktop, Claude Code, Codex CLI, Cursor, Windsurf, Gemini CLI** | [`integrations/mcp/`](integrations/mcp/README.md)             |
| **VS Code extension** (`.vsix`) | Streaming chat panel, ask-about-selection, save-code-to-knowledge (also Cursor/Windsurf/VSCodium)            | [`integrations/vscode/`](integrations/vscode/README.md)       |
| **JetBrains plugin**            | Tool-window chat + editor actions for IntelliJ, PyCharm, WebStorm, GoLand…                                   | [`integrations/jetbrains/`](integrations/jetbrains/README.md) |
| **Browser extension** (MV3)     | Popup chat + right-click "save to my AI's knowledge / memory"                                                | [`integrations/browser/`](integrations/browser/README.md)     |
| **ChatGPT Custom GPT**          | Actions schema so ChatGPT can query _your_ AI (needs a tunnel)                                               | [`integrations/chatgpt/`](integrations/chatgpt/README.md)     |

Releases: tagging `v*` triggers CI that packages the `.vsix`, browser zip, JetBrains plugin zip, and single-file executables for Windows/macOS/Linux into a GitHub Release and publishes the Docker image to GHCR. Marketplace publishing activates when `VSCE_PAT` / `OVSX_PAT` repo secrets are added; every store artifact ships icons and listing copy per the [store submission guide](docs/STORE_SUBMISSION.md).

## Architecture

```
bin/sovereign.js        CLI (start [--lan] · init · doctor · mcp · export · import · byoc)
src/
  server.js             HTTP server, REST API, SSE, static UI, bearer auth
  chat.js               orchestration: history + memory + RAG → stream
  portability.js        export manifest (per-table SHA-256) + encrypted archives
  portfolio.js          Personal Context Portfolio (pasteable markdown seed crystal)
  mcp.js                MCP server (stdio JSON-RPC, zero deps)
  memory-extract.js     automatic long-term memory extraction (opt-in)
  db.js                 SQLite storage (node:sqlite, built into Node 22)
  providers/            gateway: ollama (chat/embed/create) · openai-compat · anthropic
  training/             canonical dataset snapshots · self-hosted trainer protocol client
  ingest/               zero-dep file ingestion: ZIP reader → DOCX · PDF · text
  rag/                  chunker · BM25 · hybrid retriever
  byoc/                 SSH connector: preflight · provision · upgrade/rollback · verifiable delete
public/                 command center + wizard + Fine-Tuning Studio + XBrain triptych + guide + landing page (land.html)
integrations/           mcp · vscode · jetbrains · browser · chatgpt · trainer protocol
scripts/                install.ps1 · install.sh · build-sea.mjs (single binary) · make-icons.mjs
Dockerfile / compose    container distribution (ghcr.io image via CI)
test/                   node:test suite
```

Decision records: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## API (localhost)

`POST /api/chat` (SSE) · `POST /api/ask` (JSON) · `POST /api/distill` (SSE memory distillation over imported history) · `GET /api/mind` (provenance counts, receipts, import state) · CRUD and build routes under `/api/model-recipes` · `POST /api/create-model` (legacy direct Ollama build) · `POST /api/documents` (text or base64 PDF/DOCX) · `GET /api/search?q=` · CRUD for `personas` / `conversations` / `memories` · `GET /api/export` / `POST /api/import` (manifest-verified) · `GET /api/portfolio` · `GET /api/providers` · `GET /api/models` · `GET/PUT /api/config`

Fine-tuning routes live under `/api/training`: project/source/example curation, immutable dataset locking/export, trainer capabilities, run submit/refresh/cancel, evaluation decisions, and digest-gated Ollama persona assignment. Dataset bytes are sent only by the run-submission route after endpoint-bound consent.

Model recipe routes are `GET/POST /api/model-recipes`, `GET/PUT/DELETE /api/model-recipes/:id`, and `POST /api/model-recipes/:id/build`. A build response includes the generated Modelfile and ownership metadata so clients can show where the artifact was created.

Security: binds `127.0.0.1` by default. When `authToken` or `SOVEREIGN_TOKEN` is configured, **every** API request—including loopback and tunnel traffic—requires the bearer token. `--lan` generates one and prints a `#token=` browser URL; the browser stores it locally and sends it only as an authorization header. Tokenless localhost mode also rejects cross-origin browser writes, unsafe host headers, and non-JSON mutations.

Plain HTTP does not encrypt bearer tokens, prompts, or retrieved context. Use it only on a trusted local network or encrypted overlay/tailnet; terminate HTTPS before exposing SovereignAI anywhere else.

## Development

```bash
npm test                    # node:test — nothing to install, there are no dependencies
node scripts/build-sea.mjs  # build + smoke-test the single binary for this platform
```

The suite includes 130+ core, UI-contract, integration, API, security, config, provider, training, ingestion, CLI, single-binary, and Compose checks. Docker image builds remain covered by CI.

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
- [x] XBrain experimental triptych (Mind Field · Memory Ledger · Knowledge Atlas) with honest recall reporting
- [x] Interactive self-verifying user guide (`/guide.html`, The Sovereign Path)
- [x] BYOC rail #1: SSH deploy to any Docker host you own, with health-verified upgrades, auto-rollback, export-to-owner, and verifiable delete
- [~] BYOC rail 1.5: rent a GPU instance (RunPod, Vast.ai, Lambda Cloud) instead of bringing your own box — built and tested against mocked APIs, but **unverified against live provider infrastructure** ([details](docs/BYOC_SSH_CONNECTOR.md#rail-15--gpu-marketplace-provisioning))
- [x] Chat history import from ChatGPT and Claude's official exports (built with real confidence), Gemini via Google Takeout (experimental), and a documented generic JSON format covering every other platform ([details](docs/CHAT_IMPORT.md))
- [x] Memory provenance: every memory records how it entered (manual / auto-extracted / distilled), from which conversation, and when it was edited — never fabricated for pre-existing records
- [x] Verified, portable exports: per-table checksums and an archive digest in a [documented open format](docs/EXPORT_FORMAT.md), `sovereign verify`, and optional passphrase encryption (AES-256-GCM, scrypt)
- [x] Personal Context Portfolio: memories + personas + knowledge inventory as one pasteable markdown seed crystal (`sovereign portfolio`, `GET /api/portfolio`)
- [x] Opt-in memory distillation over imported chat history (`sovereign distill`, `import-chat --distill`) — idempotent, provenance-tagged, costs printed up front
- [x] The first five minutes: Arrival (import → live distillation → provenance-grounded reveal), the Mind control-room view as the landing surface, and streamed distillation (`POST /api/distill`) in the web UI
- [x] Cognition sovereignty: machine-written memories name their authoring model, the "cognition stays home" switch, checksummed (optionally minisign-signed) releases, and the public [Sovereignty Ledger](docs/SOVEREIGNTY.md)
- [x] Life Import rail #1 — email ([details](docs/LIFE_IMPORT.md)): zero-dep mbox scanning into evidence-backed life records, with the subscription audit and renewals radar in the Mind view
- [x] Open-weights rails: `byoc gpu serve` (rented GPU running vLLM with the open weights you choose, OpenAI-compat wire-in), weight-digest receipts on every local answer, and weight-license disclosure in the Hugging Face browser
- [x] The starter shelf + the cognition role: curated small models by job (with licenses, dated curation, and fit badges for your machine), and `memory.extractionModel` — a small local model that owns what gets learned about you while chat uses anything
- [ ] Life Import rail #2 — bank/card statements (CSV/OFX), extending the same audit with authoritative amounts

## License

[FSL-1.1-MIT](LICENSE) — the Functional Source License. Free to use, read, modify, fork, and self-host, for individuals and companies alike; the only restricted act is selling a competing SovereignAI product or service on a release younger than two years. On its second anniversary, every release automatically becomes plain MIT — that grant is irrevocable and written into the license text itself.

The covenant survives the license change, and is now enforced rather than promised: your exit is a date you can compute, not our goodwill. Nothing an individual needs to own all twelve layers is ever paywalled, rate-limited, or feature-stripped; the commercial path works by addition (a managed edition, organization features, commercial grants — see the [licensing policy](docs/LICENSING.md)), never by clawing back what's free. The code is yours to run; the [name is not](TRADEMARKS.md). Contributions ship under the [DCO](CONTRIBUTING.md) — no CLA to sign. The thin-client integrations (VS Code, JetBrains, browser) remain plain MIT.
