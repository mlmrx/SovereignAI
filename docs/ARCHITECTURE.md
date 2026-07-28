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

One Model Studio build (`POST /api/model-recipes/:id/build`): load the user-owned recipe from SQLite → validate its base model, system prompt, parameters, template, license, quantization, and seed messages → render a portable Modelfile → call `/api/create` at the configured Ollama endpoint → return both build status and ownership metadata. Recipe persistence and model-artifact storage are intentionally separate boundaries.

One fine-tuning run: explicitly select conversations → derive one-turn supervised examples → review/redact and save every included pair → freeze a deterministic conversation-grouped train/eval snapshot → bind consent to its hash and canonical trainer endpoint → content-address and upload both JSONL blobs → submit one idempotent LoRA/QLoRA job → poll the trainer's authoritative state → inspect evaluation-specific holdout metrics → record approval/rejection/skip notes → verify the trainer-attested Ollama tag and digest → assign it to a persona. `src/training/` owns the pure dataset and wire-contract logic; the external user-operated trainer owns Python/accelerator dependencies and weight updates.

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

### ADR-10: Model Studio creates configurable Ollama artifacts, not trained weights
Model Studio stores editable model recipes and builds them through the configured Ollama endpoint's `/api/create`. A recipe can describe the artifact name, base model, system prompt, inference parameters, prompt template, license, quantization, and seed messages. The build returns a readable Modelfile and produces a named model artifact that can be used outside SovereignAI on that Ollama endpoint. Quantization is passed only for eligible FP16/FP32 sources; an unsupported source/format combination remains an Ollama build error rather than being silently changed.

This is model packaging, inference configuration, and optional quantization—not weight fine-tuning. Building does not train on conversations, update the source model, or create a new foundation model. When quantization is selected, Ollama transforms the derived artifact's weight representation to the requested lower precision. That distinction is part of the product contract: the UI and API may say "build" or "create artifact," but must not imply that a recipe performs training. Fine-Tuning Studio is a separate workflow with its own consent and trainer boundary.

### ADR-11: Ownership is explicit at every storage and processing boundary
SovereignAI owns no hosted control plane. Workspace records and model recipes live in the user's selected home as SQLite state; the code is inspectable and MIT licensed; full-workspace JSON export/import carries every portable data table, including `model_recipes`. Runtime configuration and secrets are intentionally excluded from that export so a backup can be moved without silently copying credentials or redirecting restored data to an old endpoint.

A model artifact lives at the Ollama endpoint that built it. With a loopback endpoint, recipe inputs and artifact storage stay on that machine. With a non-local endpoint, build inputs cross the network and the artifact is stored by that remote Ollama service. The API reports this boundary rather than labeling every Ollama build "local." SovereignAI does not mirror or escrow the resulting weights, so artifact backup and deletion follow the operator's Ollama procedures. Portable export carries the recipe and Modelfile ingredients, not Ollama weight blobs. User control of a recipe and generated artifact does not supersede third-party base-model licenses; the recipe's `license` field is metadata, not a license grant from SovereignAI.

### ADR-12: Fine-tuning is an external, endpoint-bound weight-training protocol
SovereignAI remains a dependency-free control plane. It can curate and validate training data but cannot honestly hide Axolotl, TRL/PEFT, Unsloth, MLX-LM, drivers, and accelerator requirements inside the Node process. Training therefore uses a small, versioned HTTP contract to a trainer the user operates. The capability handshake must assert actual weight training; blobs are immutable and content-addressed; job creation uses a stable idempotency key; indeterminate jobs block duplicates and retry the same key; imported snapshots are revalidated before upload.

Source consent records the exact canonical trainer endpoint disclosed during curation. Final run consent records dataset hash, current endpoint, base model, method, and normalized hyperparameters; a changed endpoint therefore requires a fresh run confirmation while retaining the original snapshot audit trail. Credentials/private keys are blocked rather than merely acknowledged; other personal-data and quality flags require explicit acceptance. The trainer may register a merged GGUF in Ollama, but one-click assignment additionally compares the trainer-attested Ollama digest with the configured Ollama tag. Adapter/checkpoint and model deletion remain responsibilities of the trainer and Ollama operators. There is no OpenAI fine-tuning adapter or hosted fallback.

### ADR-13: Single binaries embed the untouched module graph, not a bundle
Node SEA requires a CommonJS main script, but bundling would ship rewritten code the user can no longer diff against this repository. Instead, `scripts/sea/boot.cjs` registers synchronous module hooks (`module.registerHooks`, Node 22.15+) that serve the byte-identical ES-module graph and web UI from assets embedded in the executable under a virtual URL scheme; `scripts/sea/manifest.mjs` walks the import graph and fails the build on any bare or unresolvable specifier. `postject` — the injector Node's own SEA docs prescribe — runs via npx at build time only; the runtime stays zero-dependency. The binary behaves like an installed launcher: it defaults to the stable home (`%LOCALAPPDATA%\SovereignAI` / `~/.sovereignai`) unless `SOVEREIGN_HOME` overrides it. Consequence: binaries are unsigned (ad-hoc signed on macOS), so first launch may need a SmartScreen/Gatekeeper confirmation; that trade-off is documented rather than hidden behind a signing service.

### ADR-14: Hugging Face browse is a read-only metadata lookup, never a weight proxy
Model Studio's base model field already accepted any string, including a `hf.co/<owner>/<repo>[:<quant>]` reference — Ollama's `/api/create` resolves that itself. `src/hf-catalog.js` adds a search-and-browse UI on top of that existing capability; it does not add a new class of thing SovereignAI can build. The server calls a single fixed host (`huggingface.co`), never a user-supplied one, so this intentionally does not route through the provider-URL SSRF allow/deny logic in `config.js` (ADR-6's guard exists for user-configured endpoints; there is no user-configured endpoint here to abuse). `safeFetch`'s no-redirect rule still applies. No model weights transit this server in either direction: a build still pulls straight from Hugging Face to the configured Ollama endpoint, exactly as a hand-typed `hf.co/...` base always has.

### ADR-15: GPU marketplace provisioning splits on compute style, not on provider
`sovereign byoc gpu` (rail 1.5, `src/byoc/providers/` + `gpu-provision.js`) rents a box instead of requiring the operator to already own one, but RunPod/Vast.ai and Lambda Cloud are not the same shape of thing: the first two rent a Docker *container* with no daemon inside to nest `docker build`/`docker run` in, while Lambda rents a real VM. Rather than force every provider through rail #1's SSH pipeline (which would silently not work for two of three), the code branches on a declared `computeStyle`: `'container'` providers run a pinned, pullable image directly and are reached over their mapped HTTP port — no SSH at all — while `'vm'` providers get a dedicated per-provider SSH keypair and hand off to `connector.js` `deploy()` completely unchanged once reachable. This means `computeStyle: 'container'` instances necessarily break rail #1's strongest security property: `SOVEREIGN_TOKEN` is generated by the CLI process and sent as instance env, because there is no host we control to generate it there instead. That deviation is disclosed in the deploy plan printed before every provisioning action, not hidden. Unlike every other feature added this session, none of the three provider clients could be verified against live infrastructure (no test accounts) — each file's header names the exact fields most likely to have drifted from the provider's current API.

## Data model

`personas` (system prompt, provider/model override, memory/knowledge switches) · `conversations` → `messages` (role, content, provider, model, token usage) · `memories` (long-term notes) · `documents` → `chunks` (content + optional embedding JSON) · `model_recipes` (portable Ollama build specification and last-build metadata) · `training_projects` → `training_examples` → immutable `training_datasets` → `training_runs` (submission consent, state, metrics, artifact attestations, evaluation decision, deployment lineage).

Full export = all eleven data tables in one JSON file. Configuration is omitted entirely: provider/trainer URLs, model defaults, bearer tokens, and API keys are reconfigured separately after restore. Imported training snapshots are treated as untrusted and revalidated before submission.

## Testing

`npm test` (100+ checks): retrieval and chunking, store CRUD and portability (including model recipes and training lineage), UI and editor/browser integration contracts, real-server API flows, tunnel/localhost security, config validation and atomic writes, bounded ingestion, provider/trainer cancellation and output limits, idempotent training recovery, digest-gated deployment, CLI behavior, and rendered Compose contracts. Live artifact creation remains operator-dependent; deterministic tests use protocol-faithful mock trainer and Ollama endpoints.
