# SovereignAI local trainer protocol v1

This directory documents the HTTP boundary between SovereignAI and an
optional trainer operated by the user. It intentionally contains no runnable
"trainer" that returns placeholder progress. Implementing this protocol means
performing the requested weight training and producing an attestable artifact;
an API-shaped simulation must not identify itself as a trainer.

SovereignAI itself remains a zero-runtime-dependency Node application. It
curates and snapshots reviewed examples, records consent, uploads immutable
dataset blobs, submits and monitors a job, and validates its attestation. Axolotl,
Unsloth, Hugging Face TRL/PEFT, MLX-LM, or another compatible ML runtime does
the actual LoRA/QLoRA training behind this interface.

There is no OpenAI fine-tuning adapter, hosted fallback, or
SovereignAI-operated training service. A configured non-loopback URL is a
self-hosted machine chosen by the user, not an automatic cloud route.

See [`docs/FINE_TUNING.md`](../../docs/FINE_TUNING.md) for the user workflow,
consent requirements, evaluation, and deployment policy.

The executable client contract lives in
[`src/training/client.js`](../../src/training/client.js), whose exported
constants are `TRAINER_PROTOCOL` and `TRAINING_JOB_SCHEMA`. Deterministic
dataset construction and `TRAINING_DATASET_SCHEMA` live in
[`src/training/dataset.js`](../../src/training/dataset.js). This document uses
the same field names and validation boundaries.

## Configuration and trust boundary

Training is disabled by default. The relevant SovereignAI configuration is:

```json
{
  "training": {
    "enabled": false,
    "baseUrl": "http://127.0.0.1:7331",
    "authToken": "",
    "allowRemote": false,
    "allowInsecurePrivateNetwork": false
  }
}
```

`SOVEREIGN_TRAINER_URL` and `SOVEREIGN_TRAINER_TOKEN` can supply the URL and
token without writing them through the browser. The token is masked in browser
configuration responses.

The client sends `Authorization: Bearer <token>` when a token is configured
and `Accept: application/json` on protocol requests. It uses only the fixed,
configured origin, rejects redirects, bounds response sizes and request time,
and never follows an artifact URL returned by a trainer.

The base URL must use HTTP or HTTPS and cannot contain embedded credentials, a
query string, or a fragment. Ordinary requests default to a 30-second timeout;
blob uploads default to five minutes. Callers may choose bounded overrides.

A non-loopback URL requires `allowRemote: true`. It must use HTTPS unless the
operator also makes the separate, explicit
`allowInsecurePrivateNetwork: true` exception. That exception does not make
plain HTTP private: dataset content and credentials are visible to network
observers.

## Protocol summary

The v1 surface is deliberately small:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/capabilities` | Prove protocol identity and report real training capabilities |
| `HEAD` | `/v1/blobs/sha256:<digest>` | Check whether an immutable dataset blob is already present |
| `PUT` | `/v1/blobs/sha256:<digest>` | Upload missing JSONL bytes |
| `POST` | `/v1/training/jobs` | Idempotently create an actual training job |
| `GET` | `/v1/training/jobs/:id` | Poll authoritative job state |
| `POST` | `/v1/training/jobs/:id/cancel` | Request cancellation |

Paths are relative to the configured `baseUrl`. JSON requests use
`Content-Type: application/json`. Train and evaluation blob uploads use
`Content-Type: application/x-ndjson; charset=utf-8`.

Successful capability and job responses must declare an
`application/json` or `application/*+json` content type. JSON responses are
bounded to 1 MiB by the client; a dataset manifest is bounded to 512 KiB.

No callback, WebSocket, arbitrary file path, shell command, external URL, or
server-sent event is part of v1.

## 1. Capabilities

Request:

```http
GET /v1/capabilities HTTP/1.1
Accept: application/json
Authorization: Bearer <token>
```

Required response shape:

```json
{
  "protocol": "sovereignai.trainer/v1",
  "actualWeightTraining": true,
  "methods": ["sft-lora", "sft-qlora"],
  "runner": {
    "name": "example-framework-adapter",
    "version": "pinned-version"
  },
  "models": [
    { "id": "publisher/model", "methods": ["sft-lora"] }
  ],
  "hardware": {
    "devices": [
      {
        "backend": "cuda",
        "name": "GPU name",
        "totalMemoryBytes": 17179869184,
        "freeMemoryBytes": 15000000000
      }
    ],
    "systemMemoryBytes": 34359738368,
    "freeDiskBytes": 200000000000
  },
  "limits": {
    "maxDatasetBytes": 20971520,
    "maxSequenceLength": 4096
  },
  "outputs": ["gguf"]
}
```

`protocol`, `actualWeightTraining`, and `methods` are required. The remaining
fields are optional capability details, but a guided UI should treat missing
hardware, model, or limit information as unknown rather than safe.

SovereignAI rejects a service when the protocol identifier differs or
`actualWeightTraining` is not exactly `true`. A conforming service advertises
only methods it can execute in its installed environment. V1 methods are
`sft-lora` and `sft-qlora`; a new method requires a later protocol version.

`actualWeightTraining` is an honest capability assertion, not permission to
skip result verification. A successful job must still return the required
artifact manifest, and one-click Ollama deployment verifies the named model
and trainer-attested digest at the configured Ollama endpoint.

## 2. Dataset format and blobs

SovereignAI snapshots two UTF-8 JSONL byte sequences:

- `train`: examples used to update adapter weights;
- `eval`: a holdout used for comparison and never used for weight updates.

Both blobs are required and must be non-empty. Their `records` values must be
positive integers. A snapshot with no independent evaluation group is not a
submittable v1 training job.

The format identifier is `sovereignai.training-dataset/v1`. Each line has the
canonical envelope below:

```json
{"id":"example_01","messages":[{"role":"system","content":"Return one support category."},{"role":"user","content":"I was charged twice."},{"role":"assistant","content":"billing_duplicate_charge"}],"provenance":{"sourceType":"conversation","conversationId":"conversation_01","conversationTitle":"Billing chat","personaId":"persona_01","messageIds":["message_user_01","message_assistant_01"]},"contentHash":"89cadece0724fb704fc8bcd711e91eab58bad1ec1d19d0789850f26688c07fba","riskFlags":[]}
```

The runner validates the envelope, but only `messages` is training text.
Framework adapters must not tokenize the identifier, provenance, hash, or risk
labels. `messages` contains 2-64 entries: an optional `system` message only at
the beginning, followed by strictly alternating `user` and `assistant`
messages, ending with the reviewed assistant target. Each content value and
the complete example are bounded by the dataset schema. `contentHash` is the
lowercase SHA-256 of the canonical `messages` value. Images, binary
attachments, tool calls, and hidden reasoning are not part of v1.

For each exact byte sequence, SovereignAI computes SHA-256 and uses the
lowercase content address `sha256:<64-lowercase-hex>`.

First check for an existing blob:

```http
HEAD /v1/blobs/sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef HTTP/1.1
Authorization: Bearer <token>
```

- `200` means the exact blob is present.
- `404` means SovereignAI uploads it.
- Any other status is an error; it does not authorize an upload to another
  path or host.

Upload a missing blob without changing its bytes:

```http
PUT /v1/blobs/sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef HTTP/1.1
Authorization: Bearer <token>
Content-Type: application/x-ndjson; charset=utf-8
Content-Length: <exact-byte-count>
X-Content-SHA256: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef

<raw JSONL bytes>
```

The trainer must stream the upload to bounded storage, compute the digest over
the received bytes, reject a mismatch, and publish the blob atomically only
after verification. `200`, `201`, and `204` are successful PUT responses.
SovereignAI never sends a workspace database, provider credential, or an
unapproved source record through this endpoint.

Job payloads reference blobs with this exact shape:

```json
{
  "digest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "bytes": 12345,
  "records": 50
}
```

The trainer verifies all three values while parsing the dataset. Blob presence
alone is not dataset consent; the job refers to a separately approved snapshot
and its manifest hash.

## 3. Create a training job

SovereignAI generates a local `runId` and sends it in both the idempotency
header and body:

```http
POST /v1/training/jobs HTTP/1.1
Accept: application/json
Authorization: Bearer <token>
Content-Type: application/json
Idempotency-Key: run_01J...
```

Guided-default request:

```json
{
  "schema": "sovereignai.training-job/v1",
  "runId": "run_01J...",
  "project": {
    "id": "project_01J...",
    "title": "Support category model"
  },
  "method": "sft-qlora",
  "baseModel": {
    "id": "publisher/model-7b-instruct"
  },
  "dataset": {
    "hash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "manifest": {
      "schema": "sovereignai.training-dataset/v1",
      "createdAt": "2026-07-10T18:00:00.000Z",
      "project": {
        "id": "project_01J...",
        "title": "Support category model",
        "goal": "Return the reviewed support category",
        "method": "sft-qlora",
        "baseModel": { "id": "publisher/model-7b-instruct" }
      },
      "consent": { "accepted": true },
      "split": {
        "strategy": "conversation-hash",
        "seed": "project_01J...",
        "evalRatio": 0.2,
        "leakageProtected": true
      },
      "files": {
        "train": {
          "name": "train.jsonl",
          "sha256": "1111111111111111111111111111111111111111111111111111111111111111",
          "bytes": 50000,
          "records": 90
        },
        "eval": {
          "name": "eval.jsonl",
          "sha256": "2222222222222222222222222222222222222222222222222222222222222222",
          "bytes": 6000,
          "records": 10
        }
      },
      "counts": { "total": 100, "train": 90, "eval": 10, "groups": 50 },
      "hash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    },
    "train": {
      "digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      "bytes": 50000,
      "records": 90
    },
    "eval": {
      "digest": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      "bytes": 6000,
      "records": 10
    }
  },
  "hyperparameters": {
    "epochs": 3,
    "learningRate": 0.0002,
    "batchSize": 2,
    "gradientAccumulationSteps": 8,
    "loraRank": 16,
    "loraAlpha": 32,
    "loraDropout": 0.05,
    "maxSequenceLength": 2048,
    "warmupRatio": 0.03,
    "weightDecay": 0,
    "seed": 42
  },
  "output": {
    "preserveAdapter": true,
    "mergedModel": true,
    "format": "gguf",
    "quantization": "q4_K_M"
  }
}
```

Required top-level fields are `schema`, `runId`, `project`, `method`,
`baseModel`, `dataset`, `hyperparameters`, and `output`. The schema is exactly
`sovereignai.training-job/v1`; the two run identifiers must match. The base
model ID must identify the model actually loaded by the runner. An adapter may
enrich its own audit record with an immutable upstream revision, but it must
not silently substitute another base.

The small manifest is inline and its `hash` identifies the complete immutable
dataset snapshot. `dataset.hash` repeats that value so the runner can reject a
mismatch before reading blobs. Only the train and evaluation JSONL bodies use
the blob store; there is no separate manifest blob in v1.

The output object shown above is fixed for the v1 guided flow. A runner may
advertise other outputs for its own clients, but SovereignAI v1 always requests
adapter preservation plus a merged, `q4_K_M` GGUF. Unsupported combinations
fail before training rather than being silently ignored.

Retries with the same `Idempotency-Key` and identical body return the original
job and do not start a second GPU run. Reuse of a key with a different body is
a conflict. A successful `POST` status is `200`, `201`, or `202`, with at least:

```json
{
  "id": "trainer-job-123",
  "status": "queued"
}
```

Run, project, and returned job IDs match
`^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$`. A returned ID remains opaque:
SovereignAI encodes it and never treats it as a path, URL, or shell argument.

## 4. Poll job state

```http
GET /v1/training/jobs/trainer-job-123 HTTP/1.1
Accept: application/json
Authorization: Bearer <token>
```

Example active response:

```json
{
  "id": "trainer-job-123",
  "status": "running",
  "progress": { "completed": 420, "total": 1000 },
  "metrics": {
    "trainLoss": 1.51,
    "evalLoss": 1.69,
    "step": 420
  }
}
```

`progress` and `metrics`, when present, are bounded JSON values. Progress is
runner-defined and advisory; `{ "completed", "total" }` is the recommended
shape when both values are known. These values must not echo dataset examples,
bearer tokens, local absolute paths, or other secrets.

The response `id` must exactly match the ID in the GET path. A mismatched ID is
a protocol error rather than a redirect to another job.

The trainer's allowed states are:

```text
queued -> running -> succeeded
   |         |
   |         +-> cancel_requested -> cancelled
   |         +-> failed
   +-> cancel_requested -> cancelled
   +-> failed
```

A cancellation race may end in `succeeded` or `failed` after
`cancel_requested`; the next authoritative poll decides. `succeeded`,
`failed`, and `cancelled` are terminal and immutable. A failed response includes
a bounded, sanitized `error` string.

SovereignAI also has local orchestration states that are not returned by the
trainer:

```text
draft -> review -> approved -> preparing -> uploading
       -> queued -> running -> succeeded -> deployed
                     |            |
                     |            +-> evaluation decision required
                     +-> cancel_requested -> cancelled
                     +-> failed
                     +-> unreachable (local connectivity state; safe to poll again)
```

A connectivity failure records `unreachable`; it does not rewrite the
trainer's last known state to `failed` or start a replacement job.

## 5. Cancel a job

```http
POST /v1/training/jobs/trainer-job-123/cancel HTTP/1.1
Accept: application/json
Authorization: Bearer <token>
Content-Type: application/json

{}
```

`200` or `202` means the cancellation request was accepted. Cancellation is
idempotent. The response is a job object whose status is `cancel_requested`,
`cancelled`, `succeeded`, or `failed`; returning `queued` or `running` from the
cancel endpoint is a protocol error. Acceptance does not mean accelerator work
has already stopped, so SovereignAI continues polling until a terminal state
appears.

## 6. Successful artifact and Ollama handoff

`succeeded` requires at least one artifact manifest. A trainer may return one
under `artifact` or an array under `artifacts`; SovereignAI normalizes either
form to an array and accepts at most 32 entries. The guided default is:

```json
{
  "id": "trainer-job-123",
  "status": "succeeded",
  "progress": 1,
  "metrics": {
    "trainLoss": 1.08,
    "evalLoss": 1.22
  },
  "artifact": {
    "kind": "merged-gguf",
    "sha256": "3333333333333333333333333333333333333333333333333333333333333333",
    "bytes": 4800000000,
    "baseModel": {
      "id": "publisher/model-7b-instruct"
    },
    "ollamaModel": "my-support-model:latest",
    "ollamaDigest": "4444444444444444444444444444444444444444444444444444444444444444"
  }
}
```

`kind`, lowercase `sha256`, non-negative `bytes`, and the exact `baseModel`
are required. They preserve training and export lineage. `ollamaModel` and
lowercase `ollamaDigest` must appear together. They identify a model already
registered on the user's configured Ollama endpoint and its live tag digest;
neither value is a URL or trainer-relative blob descriptor.

SovereignAI enables one-click persona deployment only when both Ollama fields
are present and `/api/tags` confirms the exact name/digest pair. It never
changes Ollama endpoints based on the trainer response. If `ollamaModel` is
omitted, SovereignAI may record the successful training/export lineage, but it
disables one-click persona deployment. Artifact weight blobs are not inserted
into the normal SovereignAI JSON export.

The trainer must merge against the exact trained base, export the requested
GGUF, and calculate its hash before reporting success. When it includes
`ollamaModel`, it must also register that named model at the operator's Ollama
endpoint first and return the digest reported by that endpoint. Returning a
model ID/digest without performing those steps is a
protocol violation.

The v1 default uses merged GGUF because Ollama warns that an adapter must match
the exact base and recommends non-quantized LoRA adapters for direct import;
framework quantization formats may differ. Direct adapter deployment can be a
future capability-gated extension, not a silent substitute for the requested
merged output. See the official [Ollama import guide](https://docs.ollama.com/import),
[Modelfile reference](https://docs.ollama.com/modelfile), and
[blob/create API](https://github.com/ollama/ollama/blob/main/docs/api.md).

## Framework adapter guidance

Every adapter must pin and report its framework version, validate the dataset
before allocating the accelerator, map only advertised settings, emit the six
protocol states, sanitize diagnostics, and return real artifact metadata.

### Axolotl

Translate `baseModel.id` to `base_model`, the method to `adapter: lora` or
`adapter: qlora`, and the normalized messages to a supported local dataset
format. For QLoRA, use the documented 4-bit loading configuration. Preserve
the adapter, merge with `axolotl merge-lora`, export GGUF, and register the
result with the configured Ollama endpoint before returning the
`ollamaModel`/`ollamaDigest` pair.

Axolotl supports local JSONL, LoRA/QLoRA, evaluation, and merging through a
configuration-driven CLI. Windows users are directed to WSL2 or Docker. See
the official [quickstart](https://docs.axolotl.ai/docs/getting-started.html),
[installation guide](https://docs.axolotl.ai/docs/installation.html), and
[Docker images](https://docs.axolotl.ai/docs/docker.html).

### Unsloth

Use a pinned Unsloth environment or official container, validate that the
selected architecture and export path are supported, and map v1 examples into
the framework's conversational dataset. Do not advertise QLoRA merely because
the package imports; the capability probe must reflect the detected device and
installed kernels.

Unsloth's published VRAM table contains absolute minimums, not a guarantee for
the chosen sequence length, batch, architecture, or export step. See the
official [documentation](https://unsloth.ai/docs) and
[hardware requirements](https://unsloth.ai/docs/get-started/fine-tuning-for-beginners/unsloth-requirements).

### Hugging Face TRL and PEFT

Use `SFTTrainer` with a `LoraConfig`; use a supported 4-bit base-loading path
for QLoRA. The adapter unwraps only the line's `messages` array and must apply
the exact production chat template. Disable Hub uploads, remote callbacks, and
external experiment tracking. Cache the model first, then use
`HF_HUB_OFFLINE=1` and `HF_HUB_DISABLE_TELEMETRY=1` for the training run.

See the official [SFTTrainer](https://huggingface.co/docs/trl/main/en/sft_trainer),
[PEFT integration](https://huggingface.co/docs/trl/main/en/peft_integration),
and [Hub environment variables](https://huggingface.co/docs/huggingface_hub/main/en/package_reference/environment_variables).

### MLX-LM

Use MLX-LM on Apple Silicon. Convert the v1 envelope into the documented local
chat JSONL view, run LoRA or QLoRA through `mlx_lm.lora`, preserve the adapter,
and use `mlx_lm.fuse --export-gguf` for the guided output. Capability results
must reflect available unified memory; a model that barely fits for inference
may not fit training and export.

See the official [MLX-LM repository](https://github.com/ml-explore/mlx-lm) and
[LoRA/QLoRA guide](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/LORA.md).

## Privacy and operational requirements

- Accept only snapshots whose manifest has `consent.accepted: true` and whose
  overall manifest hash covers that consent object.
- Store blobs, checkpoints, logs, adapters, merged weights, and their deletion
  policy under a trainer-controlled directory with owner-only permissions.
- Mount dataset content read-only when using a container; use a separate
  writable artifact volume.
- After the base model is cached, disable network access for training whenever
  the runner advertises offline operation.
- Never inherit SovereignAI's chat-provider keys. Give the trainer only its
  scoped trainer token and the minimum model-download or Ollama access it
  explicitly needs.
- Disable Weights & Biases, Hub uploads, and other external telemetry by
  default. A v1 trainer must not upload data or metrics to a hosted service.
- Explain that deleting a dataset does not remove memorized material from an
  adapter or merged model. Dataset, checkpoints, adapter, GGUF, and Ollama
  model each need their own deletion action.
- For a self-hosted non-loopback trainer, use TLS, authenticate both services,
  and disclose that reviewed examples cross the network.

## Conformance checklist

A real trainer adapter is conforming only if all of these are true:

- capability discovery reports `sovereignai.trainer/v1` and
  `actualWeightTraining: true`;
- it supports content-addressed HEAD/PUT without altering bytes;
- repeated job creation with the same run ID cannot duplicate training;
- it executes the requested advertised LoRA/QLoRA method on the exact base;
- status transitions and cancellation follow the defined state machine;
- diagnostics never echo examples or credentials;
- terminal success includes a real, hashed artifact with exact-base lineage;
- an `ollamaModel`/`ollamaDigest` claim identifies an exact tag/digest pair
  already present at the user's configured Ollama endpoint;
- no training data, metrics, or artifacts are sent to OpenAI or another hosted
  service.

Mocks may exercise the SovereignAI client in automated tests, but they must be
clearly isolated as test fixtures. This integration directory must not ship a
fake HTTP service that a user could start and mistake for actual training.
