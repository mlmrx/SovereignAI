# Local fine-tuning

SovereignAI can guide a user through actual fine-tuning without turning the
main application into an ML runtime. SovereignAI prepares and reviews the
dataset, records consent, submits an explicit job to a trainer the user
controls, presents its metrics, records the user's evaluation decision, and
can assign a digest-verified Ollama model to a persona. The separate trainer performs the
weight update.

SovereignAI does **not** bundle a trainer, silently install Python packages,
pretend that a Model Studio build is training, or send training data to an
OpenAI or other hosted fine-tuning API. If no compatible local or self-hosted
trainer is configured, the guided flow stops after producing an inspectable
dataset. It must never display a simulated training success.

The wire contract for a compatible trainer is documented in
[`integrations/trainer/README.md`](../integrations/trainer/README.md).

## Choose the right workflow first

Fine-tuning and retrieval solve different problems:

- Use knowledge retrieval when the model needs private facts, citations, or
  information that changes. A document can be corrected or deleted without
  producing another model.
- Use supervised fine-tuning when many reviewed examples show a stable task,
  response format, tone, classification boundary, or instruction-following
  behavior that prompting alone does not produce reliably.
- Use both when the behavior should be stable but the underlying facts should
  remain current and inspectable.

Model Studio's existing **Build** action is a third, separate operation. It
packages a base model with a system prompt, template, inference parameters,
license metadata, optional seed messages, and optional quantization. It does
not train on workspace data or change learned behavior through gradient
updates.

The v1 local training flow uses LoRA or QLoRA supervised fine-tuning. These are
real parameter-efficient fine-tuning methods: the
trainer learns adapter weights while the base model remains frozen. QLoRA
loads a quantized base during training to reduce accelerator memory. Neither
should be described as full-weight fine-tuning. Full-weight training is an
advanced trainer capability and is not a consumer default.

## Guided experience

### 1. Define the outcome

Ask the user to state one measurable behavior, such as "return our support
classification schema" or "answer in this reviewed editorial style." If the
goal is only "know these documents," recommend Knowledge instead.

Capture:

- the intended task and audience;
- examples of acceptable and unacceptable output;
- an evaluation rule that can be run before and after training;
- whether the result may contain personal, confidential, regulated, or
  licensed material.

### 2. Select sources explicitly

The v1 guided source is an explicit set of conversations. Show the selected
conversation names, example count, byte size, and provenance before any
trainer receives data. Documents and imported datasets are not selected
automatically by the v1 flow.

Conversations may already contain prompt-and-ideal-response pairs, but every
derived pair still requires review. Documents do not: raw paragraphs are not
automatically good supervised targets, so keep them in Knowledge unless a
future workflow turns them into specific, user-reviewed prompt/answer
examples. Version 1 must not call a remote model to synthesize examples in the
background.

Detected credentials, access tokens, private keys, and authentication secrets
are blocked from dataset locking; the detector is a guardrail, not a complete
secret scanner, so the user must still inspect every example. Hidden system
messages and unselected retrieved context are never copied automatically.
Other personal-data and quality flags require explicit acknowledgement.

### 3. Curate a portable dataset

The portable interchange is UTF-8 JSON Lines with format identifier
`sovereignai.training-dataset/v1`. Each line is one complete, inspectable
example. The trainer adapter validates the envelope and gives its framework
the conversational `messages` value:

```json
{"id":"example_01","messages":[{"role":"system","content":"Return one support category."},{"role":"user","content":"I was charged twice."},{"role":"assistant","content":"billing_duplicate_charge"}],"provenance":{"sourceType":"conversation","conversationId":"conversation_01","conversationTitle":"Billing chat","personaId":"persona_01","messageIds":["message_user_01","message_assistant_01"]},"contentHash":"89cadece0724fb704fc8bcd711e91eab58bad1ec1d19d0789850f26688c07fba","riskFlags":[]}
```

Requirements for the v1 format:

- `messages` contains 2-64 `{ "role", "content" }` objects. An optional
  `system` message may appear only first; the remainder strictly alternates
  `user`, `assistant` and ends with the reviewed assistant target.
- Roles are `system`, `user`, or `assistant`; content is non-empty text.
- `id` is the stable local example identifier; `contentHash` is the lowercase
  64-character SHA-256 hex digest of its canonical `messages` value.
- `provenance` uses `sourceType`, optional conversation/persona identifiers,
  and source message IDs; `riskFlags` is an array of local review labels.
- Binary attachments, images, tool calls, and hidden reasoning are out of
  scope for v1.
- The framework adapter must not tokenize `id`, `provenance`, `contentHash`, or
  `riskFlags`. Consent and split-level metadata remain in the separate dataset
  manifest.

Create separate `train.jsonl` and `eval.jsonl` files. The evaluation file is
the v1 holdout and is never used to update weights. Split by source
conversation or document rather than randomly separating near-duplicate rows.
This prevents a rewritten copy of a training answer from appearing in the
holdout set. The v1 snapshot uses a deterministic conversation-hash split
seeded by the project ID and records the strategy plus each file's SHA-256 in
the job manifest.

Both splits must contain at least one example before training can start. If
all approved examples come from one conversation group, ask for another
independent group instead of weakening the leakage protection.

Quality matters more than an inflated example count. Remove duplicates,
contradictory targets, accidental boilerplate, and examples that cannot be
scored. Freeze the evaluation set with the snapshot and keep it out of weight
updates; the trainer may report evaluation metrics from that fixed holdout.

### 4. Establish a baseline

Establish a baseline with the exact base model and production prompt before
training, and save the outputs and scoring rule locally. The v1 trainer
contract reports training/evaluation metrics but does not define a hosted or
automatic behavioral evaluator. A run is not successful merely because loss
decreased; the user must verify that it improves the intended behavior without
unacceptable regressions.

For subjective behavior, present base and candidate outputs in a blinded
side-by-side review. For structured tasks, measure the relevant exact-match,
schema-validity, classification, or task-specific score.

### 5. Check the machine and trainer

Query the trainer's capability endpoint before enabling **Start training**.
Display any runner/version, methods, output formats, accelerators, memory,
disk, limits, and offline-readiness information the trainer advertises.
Missing capability details are unknown, not proof that the machine is safe.

Use conservative gates rather than a framework's absolute minimum:

- Without a supported accelerator, offer dataset export instead of promising
  useful local LLM training.
- An 8 GB NVIDIA GPU is an entry path for roughly 1B-3B QLoRA models.
- A 12-16 GB NVIDIA GPU may handle a 7B-8B QLoRA model with short context,
  `batchSize` 1, and checkpointing, but model architecture and sequence
  length can materially change memory use.
- Apple Silicon should use an MLX-LM adapter and select a model that leaves
  headroom in unified memory.
- Merging and export may need the downloaded base, checkpoints, merged
  weights, and GGUF on disk at the same time. Calculate disk needs from actual
  input sizes rather than a fixed marketing estimate.

Unsloth publishes absolute-minimum VRAM figures and warns that some models
need more. Axolotl currently documents NVIDIA or AMD accelerators and
recommends WSL2 or Docker on Windows. Treat both as preflight inputs, not
guarantees. See [Unsloth requirements](https://unsloth.ai/docs/get-started/fine-tuning-for-beginners/unsloth-requirements)
and [Axolotl installation](https://docs.axolotl.ai/docs/installation.html).

### 6. Record informed consent

Immediately before upload, show one final review containing:

- the exact source records and generated split sizes;
- the trainer URL and whether it is loopback, another user-controlled host,
  or an unsupported external destination;
- the base-model identifier and the license/revision the operator verified;
- the tuning method and the difference between adapter and full-weight
  training;
- estimated GPU memory, system memory, disk use, and duration as estimates;
- which datasets, checkpoints, logs, adapters, and merged models will remain;
- the deletion controls for each retained item;
- a warning that trained weights can memorize examples and that deleting a
  source document does not unlearn it from an existing artifact.

Dataset consent is tied to the reviewed snapshot hash and canonical trainer
endpoint. Run consent additionally records that hash, endpoint, base model,
method, and normalized hyperparameters. Changing them requires a new run
confirmation; the snapshot retains the originally disclosed endpoint for its
audit trail. The user must affirm that they
have the right to use the selected data and base model for training and any
intended distribution.

### 7. Train with honest progress

Upload the frozen dataset blobs, then submit one training job. Status comes
only from the configured trainer. SovereignAI maps the trainer's states into
the guided UI and preserves bounded, redacted diagnostics; it does not infer
progress from a timer.

Cancellation requests are idempotent. A cancel response means the trainer
accepted the request, not that GPU work has already stopped. Continue polling
until the job reaches `cancelled`, `failed`, or `succeeded`.

### 8. Evaluate and approve

When training succeeds, validate the trainer's artifact attestation and
base-model identity, review identifiable fixed-holdout metrics, and test representative prompts
against the base and candidate. Record improvements and regressions in the
evaluation decision. Deployment requires either approval backed by identifiable
holdout metrics or an explicit skip with explanatory notes; a completed trainer
job is not automatic permission to replace a persona's model.

### 9. Deploy or export

Preserve the learned adapter and its manifest even when producing a merged
model. It is smaller, records the actual training result, and can support
continued training. A merged or quantized artifact is a derived deployment
copy.

For Ollama, the v1 handoff is:

1. Merge the adapter with its exact base in the trainer.
2. Export a GGUF artifact.
3. Register the named model at the same Ollama endpoint configured in
   SovereignAI and return both the tag and live Ollama digest.
4. Have SovereignAI compare that attested digest with `/api/tags`; a stale or
   same-name different model is rejected.
5. Assign the verified tag to the explicitly selected persona. SovereignAI
   does not upload or convert GGUF bytes in this v1 handoff.

Direct adapter deployment is an advanced path. Ollama requires the same base
model used for tuning and warns that a mismatch produces erratic behavior.
Its current import guidance recommends non-quantized LoRA adapters because
framework quantization methods differ. Direct Safetensors adapter support is
also architecture-limited. Prefer a merged GGUF for QLoRA or whenever exact
base compatibility cannot be proven. See the official
[Ollama import guide](https://docs.ollama.com/import),
[Modelfile `ADAPTER` reference](https://docs.ollama.com/modelfile), and
[blob/create API](https://github.com/ollama/ollama/blob/main/docs/api.md).

An Ollama artifact lives at the endpoint that creates it. If that endpoint is
not loopback, the weight artifact crosses the network and is stored on that
other system. Training-project metadata, reviewed examples, immutable JSONL,
run history, metrics, and artifact attestations are included in workspace
JSON export. Adapter/checkpoint/GGUF weight files are not; back them up and
delete them through the trainer and Ollama storage controls.

## Local and self-hosted privacy boundary

This workflow contains no OpenAI fine-tuning integration and no
SovereignAI-operated cloud service. The application does not choose a hosted
trainer, upload datasets to a SaaS endpoint, or send training telemetry.

A user may configure a trainer on another machine they control. That remains
self-hosted, but it is not "data stays on this device." The UI must name the
host and state that the selected examples and resulting artifacts cross the
network. Use TLS and scoped authentication outside loopback.

For a local Hugging Face-based runner, cache the approved model first and then
train with networking disabled. Set `HF_HUB_OFFLINE=1` and
`HF_HUB_DISABLE_TELEMETRY=1`; disable Weights & Biases and other remote loggers.
The Hugging Face Hub documents both controls in its
[environment-variable reference](https://huggingface.co/docs/huggingface_hub/main/en/package_reference/environment_variables).
Mount reviewed datasets read-only in a container, grant a separate writable
artifact directory, and do not pass SovereignAI provider keys into the
trainer.

## Supported trainer families

The HTTP contract deliberately does not expose framework-specific flags. A
trainer adapter translates the versioned job into one pinned framework
configuration:

- **Axolotl:** config-driven local JSONL training, LoRA/QLoRA, evaluation, and
  adapter merging. See the official
  [quickstart](https://docs.axolotl.ai/docs/getting-started.html) and
  [Docker guide](https://docs.axolotl.ai/docs/docker.html).
- **Unsloth:** optimized local LoRA/QLoRA with an official container and
  published hardware guidance. See the official
  [documentation](https://unsloth.ai/docs) and
  [requirements](https://unsloth.ai/docs/get-started/fine-tuning-for-beginners/unsloth-requirements).
- **Hugging Face TRL + PEFT:** the reference Python adapter for supervised
  training with `SFTTrainer`, LoRA, and QLoRA. See the official
  [SFTTrainer](https://huggingface.co/docs/trl/main/en/sft_trainer) and
  [PEFT integration](https://huggingface.co/docs/trl/main/en/peft_integration)
  documentation.
- **MLX-LM:** the Apple Silicon adapter, supporting local chat JSONL,
  LoRA/QLoRA/full tuning, and GGUF export. See the official
  [MLX-LM repository](https://github.com/ml-explore/mlx-lm) and
  [LoRA guide](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/LORA.md).

Framework availability is not proof that a particular base architecture,
chat template, quantization method, or export path is compatible. The trainer
must advertise current capabilities. SovereignAI enforces advertised method,
model (when listed), GGUF output, dataset-size limit, and sequence-length
limit. Other compatibility and hardware claims remain the trainer operator's
responsibility.
