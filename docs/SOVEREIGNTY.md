# The Sovereignty Ledger

"Sovereign AI" is a claim most products make and none audit. This page is
SovereignAI's audit of itself: every layer of the stack, what we actually
control, what we don't, and what your exit is. It is maintained with the
same rule as the rest of the product — **an unknown is reported as unknown,
not rounded up to a feature.**

Truly sovereign AI — every layer owned, down to the model's weights and the
data they were trained on — does not exist in 2026, for us or anyone. What
this product builds is *maximum achievable sovereignty at every layer, every
compromise disclosed, every exit built before the door.*

## The ledger

| Layer | Status | What you control | The honest compromise | Your exit |
|---|---|---|---|---|
| **Your data** | 🟢 Sovereign | Everything: SQLite in a directory you choose, no hosted control plane, no telemetry, secrets never exported | No at-rest DB encryption (use OS disk encryption); plain HTTP on localhost | Checksummed, optionally encrypted export in a [documented open format](EXPORT_FORMAT.md) any tool can read |
| **Provenance** | 🟢 Sovereign | Every memory records how it entered, from which conversation, which model wrote it, and when it was edited | Records predating v0.5 tracking honestly say "unknown" — we refuse to backfill | Provenance round-trips through export; the [portfolio](../README.md) carries receipts into any other tool |
| **Runtime** | 🟢 Sovereign | Zero npm dependencies — the code you audit is the code that runs; single binary or run-from-source | Node.js itself (and V8 under it) is a runtime we did not write or audit | Runs from source with nothing but Node; MIT license means the code survives us |
| **Retrieval / knowledge** | 🟢 Sovereign | Zero-dep local parsing (PDF/DOCX/ZIP), BM25 always works offline | Semantic embeddings require an embedding model (see Model layer) | Keyword search degrades gracefully; documents re-export as-is |
| **Distribution** | 🟡 Conditional | `SHA256SUMS.txt` on every release; minisign signature when configured; reproducible path = clone and run from source | Binaries are unsigned by an OS vendor; GitHub/GHCR is a single distribution point owned by Microsoft | Source checkout — the zero-trust install that needs none of our artifacts |
| **Compute (BYOC)** | 🟡 Conditional | Rail #1: hardware you own, host-key pinning, token hashes only, verifiable delete | Rail 1.5 (rented GPUs) is tenancy: the marketplace owns the disk, and container-style deploys expose the instance token to the provisioning CLI (disclosed in the deploy plan) | `export-to-owner` streams your data home; `destroy --purge-data` verifies removal |
| **The model** | 🔴 Borrowed | Where inference runs (local Ollama / any OpenAI-compatible server / BYO-key Anthropic), which model, per persona | The weights are someone else's artifact — trained on unknown data with unknown priors, unauditable in practice. Ollama is a de-facto dependency with its own registry; any OpenAI-compatible local server (llama.cpp, vLLM) works without it | Models are swappable per persona in minutes; Model Studio recipes and fine-tuning lineage are portable data |
| **Cognition (who writes your memory)** | 🟡 Conditional | Machine-written memories name their author model (`author_provider/author_model`). The **"cognition stays home"** switch restricts memory-writing model calls to local endpoints even when chat uses a remote provider | With the switch off and a remote chat provider, a third party's model is the lens deciding what is durable about you — disclosed at the point of use | Turn the switch on; or delete any machine-written memory — the ledger shows exactly which those are |

## The ownership map — everything an individual owns here, as built

The ledger above audits claims. This list enumerates the ownables: every
layer a person holds in this product today, each named with the shipped
mechanism that delivers it — not an aspiration.

1. **Your hardware** — it runs where you decide: laptop, homelab, your VPS
   (`sovereign byoc deploy`), even a rented GPU with the trade-offs printed
   before provisioning.
2. **Your runtime** — zero-dependency, MIT-licensed code; the single binary
   embeds the same byte-identical files you can read in this repository.
3. **Your data** — one SQLite folder you can copy, permissioned to you,
   where deleted means zeroed (`secure_delete`), not soft-hidden.
4. **Your AI's identity** — its name, personas, and system prompts are
   records you edit and export, not settings a vendor hosts.
5. **Your models** — local open weights, swappable per persona; Model
   Studio recipes build named artifacts on the Ollama endpoint you control.
6. **Your fine-tuning** — datasets you curated, consent you recorded,
   adapters trained on a trainer you operate, lineage kept end to end.
7. **Your memory** — every durable fact carries its origin, source
   conversation, authoring model, and edit time. Receipts, not vibes.
8. **Your cognition policy** — you decide which models may *write* memory
   ("cognition stays home") and whether automatic learning runs at all.
9. **Your knowledge** — documents parsed on your machine by dependency-free
   parsers, into an index you can preview before any model sees it.
10. **Your history** — conversations born here or imported from ChatGPT,
    Claude, and Gemini, plus the life records mined from your own inbox —
    every one carrying the evidence it was built from.
11. **Your access** — localhost by default; your LAN/tailnet behind your
    token; editors, browser, phone, and MCP clients all reading the same
    store you own, none of them able to keep it from you.
12. **Your exit** — the checksummed export in a documented open format,
    optional passphrase encryption, the pasteable portfolio, BYOC
    export-to-owner, and verifiable deletion. Tested, not promised.

## What we will not do

- **Custody of your credentials** — no cloud connectors that hold your bank
  or email logins. Data comes in through exports you fetch yourself.
- **A hosted control plane** — there is no SovereignAI server your instance
  reports to, and there never will be.
- **Silent downgrades** — when a sovereignty property cannot hold (rented
  GPU token exposure, remote extraction, unverifiable model claims), the
  product says so at the point of use instead of averaging it into a green
  checkmark.

## How to read a competitor's page against this one

Ask three questions of any "private AI" product: *Can I read every line
that runs? Can I take everything out, verified, in a documented format?
When something isn't private, does the product tell me at that moment?*
This ledger is our answer sheet. Demand one from everyone else.
