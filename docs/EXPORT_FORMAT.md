# SovereignAI Export Format

This document specifies the archive `sovereign export` writes and `sovereign
import` reads. It exists so the archive is useful **without SovereignAI**: any
tool can read, verify, produce, or migrate this format from this page alone.
If you build an importer or exporter against it, you are the audience.

Format names are versioned independently of the app: this page describes
`sovereignai-export/1` and `sovereignai-export-encrypted/1`.

## Design commitments

1. **No prose flattening.** Every table exports as structured rows with ids,
   timestamps, and relationships intact — a re-import reconstructs state, not
   a transcript of it.
2. **Verifiable, not just downloadable.** The archive carries checksums of its
   own contents (see [Manifest](#manifest)). Verification detects corruption,
   truncation, and silent modification.
3. **Honest limits.** The manifest is *integrity*, not *authenticity*: there
   is no signature, so it proves the file matches itself, not who wrote it.
   Secrets (provider keys, tokens, trainer endpoints) are deliberately never
   exported.

## Plaintext envelope (`sovereignai-export/1`)

```json
{
  "sovereignai": "0.5.0",
  "format": "sovereignai-export/1",
  "exportedAt": "2026-08-04T12:00:00.000Z",
  "manifest": { "algorithm": "sha256-json-v1", "tables": { "...": {} }, "sha256": "…" },
  "data": {
    "personas": [],
    "conversations": [],
    "messages": [],
    "memories": [],
    "documents": [],
    "chunks": [],
    "model_recipes": [],
    "training_projects": [],
    "training_examples": [],
    "training_datasets": [],
    "training_runs": []
  }
}
```

- `sovereignai` — version of the app that wrote the archive.
- `format` — envelope identifier; bump suffix on breaking change.
- `data` — one array of row objects per table. All eleven keys are optional on
  import; present tables are validated and upserted by `id`.
- Exports written before v0.5 have no `format` or `manifest` key; importers
  MUST accept their absence.

## Manifest

`algorithm: "sha256-json-v1"` means:

- For each table: `tables[name].sha256 = SHA-256(JSON.stringify(rows))` over
  the UTF-8 bytes of the compact JSON serialization of that table's array,
  exactly as parsed from this file (`JSON.stringify(JSON.parse(file).data[name])`).
  `tables[name].rows` is the array length.
- `manifest.sha256` (the archive digest) = SHA-256 of the string formed by
  joining `"<name>:<tableSha256>"` for every table, sorted by table name,
  with `"\n"`.

Verification recomputes both and compares. Rules for importers:

- Manifest present and matching → import.
- Manifest present and mismatching → **refuse**, and say which tables differ.
  The owner's documented escape hatch for deliberate hand-edits is deleting
  the `manifest` key — an explicit act that leaves no ambiguity about whether
  verification happened.
- Manifest absent → import, and say that no verification happened.

## Encrypted envelope (`sovereignai-export-encrypted/1`)

The plaintext envelope above, serialized and encrypted:

```json
{
  "format": "sovereignai-export-encrypted/1",
  "kdf":    { "name": "scrypt", "N": 16384, "r": 8, "p": 1, "salt": "<base64, 16 bytes>" },
  "cipher": { "name": "aes-256-gcm", "iv": "<base64, 12 bytes>", "authTag": "<base64, 16 bytes>" },
  "ciphertext": "<base64>"
}
```

- Key = scrypt(passphrase, salt, 32 bytes) with the recorded `N`, `r`, `p`.
- Plaintext = the full plaintext envelope JSON (manifest included), UTF-8.
- Decryptors MUST bounds-check declared kdf parameters before deriving
  (SovereignAI refuses `N > 2^20`, non-power-of-two `N`, `r > 32`, `p > 16`)
  so a hostile file cannot turn key derivation into a memory bomb.
- GCM's auth tag already authenticates the ciphertext; the inner manifest
  additionally survives decryption for at-rest verification workflows.

Everything needed to decrypt except the passphrase is in the file — standard
OpenSSL/libsodium tooling can recover the data without SovereignAI.

## Table schemas

Field types are JSON. `null`-able fields say so. Timestamps are ISO-8601
strings. Ids are opaque strings unique within their table.

### personas
`id, name, description, system_prompt, provider (null), model (null), temperature (null), use_memory (0|1), use_knowledge (0|1), created_at, updated_at`

### conversations
`id, persona_id (null), title, created_at, updated_at, external_id (null), source_platform (null), distilled_at (null)`

- `external_id` + `source_platform` identify a conversation imported from
  another AI platform (idempotency key for re-imports).
- `distilled_at` — when this imported conversation was last swept for durable
  memories; `null` = never swept.

### messages
`id, conversation_id, role (user|assistant|system), content, provider (null), model (null), tokens_in (null), tokens_out (null), created_at`

### memories
`id, content, created_at, origin (null), source_conversation_id (null), updated_at (null), author_provider (null), author_model (null)`

- `origin` — how the memory entered the system: `"manual"` (recorded by the
  owner), `"extracted"` (auto-extracted from a live chat), `"distilled"`
  (distilled from imported history), or `null` (recorded before provenance
  tracking existed, v0.5 — deliberately not backfilled; an unknown origin is
  reported as unknown, not guessed).
- `source_conversation_id` — provenance pointer, not a live foreign key: the
  conversation may since have been deleted and the pointer stays truthful.
- `updated_at` — last edit; `null` = never edited since tracking began.
- `author_provider` / `author_model` — which model wrote a machine-authored
  memory (`extracted`/`distilled` origins). `null` on manual rows (the author
  is the human) and on rows predating tracking.

### documents
`id, name, size, chunk_count, embedded (0|1), created_at`

### chunks
`id, document_id, idx, content, embedding (JSON string of number[] | null)`

### model_recipes
`id, title, name, base, system, parameters (JSON string), template, license, messages (JSON string), quantize (null), created_at, updated_at, last_built_at (null)`

### training_projects / training_examples / training_datasets / training_runs
The fine-tuning lineage tables; see `docs/FINE_TUNING.md`. Notable:
`training_examples.provenance` (JSON string) and `content_hash` (SHA-256) —
the same provenance-and-integrity discipline this format applies to memory.

## What is deliberately NOT exported

Runtime configuration and secrets: provider URLs and API keys, trainer
endpoints, bearer tokens. A backup must be movable without silently copying
credentials or redirecting a restored instance at an old endpoint. Configure
these again after restore.

## Related surfaces

- `sovereign verify <file>` — check an archive against its manifest without
  importing.
- `sovereign portfolio` — NOT this format: a human-readable markdown
  distillation (memories with provenance, personas, knowledge inventory)
  made for pasting into other tools, not for restore.
