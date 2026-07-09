# SovereignAI

A platform for creating your own sovereign AI — an assistant you own, running on models you choose, with data that never leaves your control.

> **Status:** early concept. This repo is the starting point for design, prototyping, and eventually the platform itself.

## The idea

Most people's "AI" today is a rented seat on someone else's infrastructure: their models, their memory, their rules, their telemetry. SovereignAI is a tool that lets anyone stand up an AI that is genuinely *theirs*:

- **Own the runtime** — run locally or on infrastructure the user controls (home server, VPS, private cloud).
- **Own the data** — conversation history, memory, and documents stored where the user decides, portable and exportable by default.
- **Choose the brain** — plug in local open-weight models (Llama, Mistral, Qwen, etc.) or bring-your-own-key cloud APIs, and switch freely.
- **Shape the behavior** — user-defined persona, system prompts, tools, and guardrails, versioned like code.
- **No lock-in** — everything (config, memory, knowledge base) lives in open formats the user can take anywhere.

## What the platform could look like

Rough shape to be validated during prototyping:

| Layer | Responsibility |
|---|---|
| **Setup wizard / CLI** | One command or guided flow: pick a model backend, storage location, and persona → get a running assistant |
| **Model gateway** | Uniform interface over local runtimes (Ollama, llama.cpp, vLLM) and BYO-key cloud APIs |
| **Memory & knowledge** | Local-first store for chat history, long-term memory, and user documents (RAG) |
| **Persona & policy** | Declarative config for identity, tone, tools, and permissions — diffable, versioned, shareable |
| **Interfaces** | Web UI, CLI, and an API so the assistant can be reached from anywhere the user allows |

## Roadmap (draft)

1. **Define** — sharpen the target user and the minimum "sovereign" guarantees (this doc).
2. **Prototype** — thin vertical slice: wizard → local model → chat with persistent local memory.
3. **Platform** — multi-model gateway, RAG, persona config, packaged self-host deployment.
4. **Ecosystem** — shareable personas/tool packs, one-click deploy targets.

## Contributing / working notes

Nothing is settled yet — stack, architecture, and scope are all open. Design notes and decisions will live in `docs/` as they happen.
