# Architecture & Decision Records

## System overview

```
                       ┌────────────────────────────────────────┐
  Web UI (no build) ──▶│              src/server.js             │
  VS Code extension ──▶│   REST API + SSE + static + auth       │
  Browser extension ──▶│                                        │
  ChatGPT Actions ────▶│  ┌──────────┐  ┌─────────┐  ┌───────┐  │
                       │  │ chat.js  │─▶│providers│─▶│ Ollama│  │
  MCP clients ────────▶│  │orchestr. │  │ gateway │  │ OpenAI│  │
  (Claude, Codex,      │  └────┬─────┘  └─────────┘  │ compat│  │
   Cursor, Gemini) ───▶│       │                     │Anthro.│  │
        src/mcp.js     │  ┌────▼─────┐  ┌─────────┐  └───────┘  │
                       │  │  db.js   │  │  rag/   │             │
                       │  │ SQLite   │  │ chunker │             │
                       │  │ (local)  │  │ BM25    │             │
                       │  └──────────┘  │ hybrid  │             │
                       │                └─────────┘             │
                       └────────────────────────────────────────┘
```

One chat turn (`POST /api/chat`): resolve persona → load trimmed history → inject long-term memory notes (if persona uses memory) → retrieve top-k knowledge chunks for the query (if persona uses knowledge) → compose system prompt → stream from the provider → persist both turns + usage → emit SSE (`meta`, `delta`*, `done`).

## Decision records

### ADR-1: Zero runtime dependencies
The product promise is sovereignty; a 400-package `node_modules` is a supply chain the user can't audit. Node 22 provides everything needed natively: `node:sqlite`, `node:http`, `fetch`, `node:crypto`, `node:test`. Consequence: we hand-roll small things (router, SSE parser, BM25) — each is <150 lines and testable. Dev-time tools (e.g. `vsce` for packaging the VS Code extension) are acceptable; runtime deps are not.

### ADR-2: SQLite via `node:sqlite`
Single-file, user-ownable, trivially exportable, no server. The module is experimental in Node 22 but API-stable enough; we suppress the warning with `--no-warnings`. Fallback plan if it regresses: the `Store` class is the only touchpoint — swappable for a JSON-file store without touching callers.

### ADR-3: Provider gateway as async generators
Every provider implements `chatStream()` yielding `{type:'delta'|'done'}`. SSE (Anthropic/OpenAI-compat) and NDJSON (Ollama) parsing are isolated in `providers/parsers.js`. Anthropic is spoken natively (Messages API, `anthropic-version: 2023-06-01`) — never through an OpenAI-compat shim; note that modern Claude models reject `temperature`, so the gateway never sends sampling params to Anthropic.

### ADR-4: Hybrid retrieval with graceful degradation
Embeddings (Ollama `/api/embed`) are optional. Every chunk is always BM25-indexable; when embeddings exist for both query and chunks, scores blend (0.65 semantic + 0.35 keyword). Consequence: knowledge search works on a fresh machine with no models pulled, and silently upgrades when an embedding model appears.

### ADR-5: MCP as the universal AI-platform integration
Rather than one bespoke plugin per AI product, `sovereign mcp` (stdio JSON-RPC) surfaces memory/knowledge/chat as MCP tools. Claude Desktop/Code, Codex CLI, Cursor, Windsurf, and Gemini CLI all consume it with a few lines of config. ChatGPT is the exception (Actions + OpenAPI + tunnel) — handled separately.

### ADR-6: Localhost-first, tunnel-safe security
Server binds `127.0.0.1`. When `authToken` is configured, every API request—including loopback traffic from a local tunnel or reverse proxy—requires Bearer auth. Tokenless localhost mode permits native clients but rejects unsafe browser origins, untrusted Host headers, and non-JSON mutations. Browser bootstrap tokens travel in the URL fragment (never the HTTP request) and are then stored locally. API keys are masked in browser config responses; portable exports omit configuration entirely, and masked values sent back by the UI preserve the real secret.

### ADR-7: No-build web UI
Vanilla HTML/CSS/JS served statically. No bundler, no framework, no telemetry. Chat streaming reads the SSE body via `fetch` + `ReadableStream` (POST-based SSE, since `EventSource` is GET-only). Markdown rendering is a minimal escaped-first subset (code fences, inline code, bold, links).

### ADR-8: Zero-dep document ingestion
DOCX is a ZIP of XML; PDF text lives in content streams. Both are parseable with Node built-ins: a ~70-line ZIP reader (`ingest/zip.js`, stored + deflate via `zlib.inflateRawSync`) feeds the DOCX extractor, and the PDF extractor inflates FlateDecode streams and walks the text operators (Tj/TJ/'/"/Td/T*). Best-effort by design: unreadable output (scanned pages, CID fonts) fails loudly with a clear message instead of indexing noise. Binary uploads travel as base64 JSON (`contentBase64`) to keep the API surface JSON-only.

### ADR-9: Auto memory extraction is opt-in and fire-and-forget
When `memory.autoExtract` is on, each chat exchange triggers one background model call that distills ≤3 durable facts into memory notes. It never blocks or delays the chat stream, failures are silent, and parsing tolerates model quirks (bullet variants, stray NONE lines). Off by default: it costs a model call per exchange and users should choose to be profiled, even locally.

### ADR-10: "Bake your own model" via Ollama Modelfile
`POST /api/create-model` calls the configured Ollama endpoint's `/api/create` (base model + system prompt → new named model). This creates a literal model artifact on that endpoint (`ollama list` there shows it), usable outside SovereignAI too. Fine-tuning is a different beast (planned as JSONL export first); baking delivers a reusable named-model experience today at zero training cost.

## Data model

`personas` (system prompt, provider/model override, memory/knowledge switches) · `conversations` → `messages` (role, content, provider, model, token usage) · `memories` (long-term notes) · `documents` → `chunks` (content + optional embedding JSON). Export = all six tables + redacted config, one JSON file.

## Testing

`npm test` (85+ checks): retrieval and chunking, store CRUD and portability, UI and editor/browser integration contracts, real-server API flows, tunnel/localhost security, config validation and atomic writes, bounded ingestion, provider cancellation and output limits, CLI behavior, and rendered Compose contracts. Live model verification remains provider-dependent.
