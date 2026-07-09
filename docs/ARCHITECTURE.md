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

### ADR-6: Localhost-first security
Server binds `127.0.0.1`. Remote requests are refused unless `authToken` is configured, then require Bearer auth. API keys are redacted in every config/export response (`••` masking); masked values sent back by the UI are recognized and preserved rather than overwriting the real secret.

### ADR-7: No-build web UI
Vanilla HTML/CSS/JS served statically. No bundler, no framework, no telemetry. Chat streaming reads the SSE body via `fetch` + `ReadableStream` (POST-based SSE, since `EventSource` is GET-only). Markdown rendering is a minimal escaped-first subset (code fences, inline code, bold, links).

## Data model

`personas` (system prompt, provider/model override, memory/knowledge switches) · `conversations` → `messages` (role, content, provider, model, token usage) · `memories` (long-term notes) · `documents` → `chunks` (content + optional embedding JSON). Export = all six tables + redacted config, one JSON file.

## Testing

`node --test` (21 tests): BM25 ranking, chunker bounds/overlap, store CRUD + export/import round-trip, and API integration tests that boot the real server on an ephemeral port (hermetic: embeddings disabled, providers off). Live verification (manual, documented in commits): streamed chat via Ollama llama3.1, RAG-grounded citation, MCP handshake + tool calls.
