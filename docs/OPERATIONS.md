# Operations

## State and instances

An installed `sovereign` launcher uses one stable home, independent of the
terminal's current directory:

- Windows installer: `%LOCALAPPDATA%\SovereignAI`
- macOS/Linux installer: `~/.sovereignai`
- Single binary (`sovereign-v*-{win,macos,linux}-*` from GitHub Releases): the
  same stable home as the platform installer
- Docker: `/state`

The home contains `sovereign.config.json` and `data/sovereign.db`. Set
`SOVEREIGN_HOME` explicitly to select another instance. Running the source
directly without that variable remains project-local and uses the current
directory.

Use `sovereign doctor` to check the active home, configuration, database
integrity/counts, provider connectivity, and selected chat/embedding models.
It also notices a local [FreeToken](https://github.com/FlashML-org/FreeToken) engine
running at its configured URL (`http://127.0.0.1:1919` by default) that is not yet enabled, as an `[info]` line
with a next step — never a failure. It never prints bearer tokens or provider
API keys. For a local-only check:

```bash
sovereign doctor --no-network
```

The command exits non-zero when it finds a failure, making it suitable for
smoke checks.

Provider environment overrides: `FREETOKEN_BASE_URL` works like
`OLLAMA_BASE_URL` (it also enables the FreeToken provider, since setting the
URL is the intent). `SOVEREIGN_HARDWARE_PROBE=off` disables the best-effort GPU
probe (`nvidia-smi`, then Linux sysfs) that sizes the starter shelf's sparse
MoE tier; without it the shelf reports the GPU as unknown rather than guessing.

The customs declaration (what leaves your machine, shown before it leaves) is
configured under `privacy` in `sovereign.config.json`:
`privacy.outgoingPreview` is `"ask"` (default — the web UI shows the exact
outgoing context before every send to a remote provider) or `"off"`;
`privacy.outgoingPreviewTrusted` lists provider ids (`ollama`, `freetoken`,
`openai`, `anthropic`) the user chose "don't ask again" for, and is what the
Revoke chips under Settings → Data & privacy edit. Local endpoints never ask,
because nothing leaves. Headless channels — the CLI, `/api/ask`, MCP, the
editor and browser integrations, ChatGPT Actions — do not show the
declaration; every remote answer still carries the `outgoing` receipt.

JSON exports restore personas, conversations, messages, memories, documents,
chunks, Model Studio recipes, and Fine-Tuning Studio projects, reviewed
examples, immutable JSONL snapshots, run records, metrics, evaluation
decisions, and deployment lineage. Provider/trainer URLs, model defaults,
bearer tokens, and API keys are omitted entirely and must be reconfigured separately. This is
deliberate: moving a data backup must not silently copy credentials or send a
restored workspace to an old endpoint. Export files contain private workspace
content and are created with owner-only permissions on POSIX systems when
written by the `sovereign export` CLI. Browser downloads follow the browser and
operating system's download permissions.

## Verifying release downloads

Every release attaches `SHA256SUMS.txt` covering all assets (v0.5.0's was
computed and attached after the fact).
After downloading a binary or extension artifact:

```bash
sha256sum --check --ignore-missing SHA256SUMS.txt      # Linux
shasum -a 256 --check --ignore-missing SHA256SUMS.txt  # macOS
# Windows PowerShell: compare Get-FileHash <file> against the entry in SHA256SUMS.txt
```

When the maintainer has configured a signing key, the release also carries
`SHA256SUMS.txt.minisig`; verify with the published public key:

```bash
minisign -V -P <public key from README> -m SHA256SUMS.txt
```

Checksums prove the file you got is the file CI produced; the signature
additionally proves who produced it. The strongest path needs neither:
**clone the repository and run from source** — `git clone`, read the code
(there are no runtime dependencies to audit around), `node bin/sovereign.js
start`. That path involves trusting only Node.js and this repository's
history.

Since v0.5, exports carry a checksum manifest ([format spec](EXPORT_FORMAT.md)):
`sovereign verify <file>` checks an archive without importing it, and
`sovereign import` refuses an archive whose contents no longer match — delete
the file's `manifest` field to import a deliberately hand-edited export.
`sovereign export --encrypt` wraps the archive in AES-256-GCM with a key
derived (scrypt) from a passphrase only you hold: use it whenever a backup
leaves hardware you control (rented GPU hosts, shared drives, cloud storage).
Set `SOVEREIGN_EXPORT_PASSPHRASE` for non-interactive runs. A lost passphrase
is unrecoverable by design.

## Ownership, backup, and restore

There are four distinct things to own and back up:

1. **Workspace state** — `data/sovereign.db` contains personas, conversations,
   messages, memory, documents, retrieved chunks, embeddings, and model
   recipes, and fine-tuning control-plane history. Prefer `sovereign export` for a consistent, inspectable transfer
   while the app is running.
2. **Runtime configuration** — `sovereign.config.json` contains endpoint URLs
   and may contain credentials. It is outside the portable data export by
   design. Back it up only through your normal secret-management process.
3. **Ollama artifacts** — named models built by Model Studio live at the
   configured Ollama endpoint, not inside the SovereignAI database or JSON
   export. The export contains the portable recipe and Modelfile ingredients,
   not Ollama weight blobs. Back up, copy, or remove artifacts using the
   controls for that Ollama installation.
4. **Trainer artifacts** — adapters, checkpoints, optimizer state, merged
   weights, GGUF files, and trainer logs live in the trainer's configured
   artifact store. SovereignAI keeps attestations and lineage, not those large
   files. Back them up or delete them through the trainer. Deleting a local
   Fine-Tuning Studio project removes local metadata only.

This separation keeps the portable recipe available even when the original
artifact or endpoint is gone: restore the JSON export, configure an Ollama
endpoint you control, inspect the generated Modelfile, and build again. A full
restore does not reconnect providers or recreate model artifacts automatically.

Treat exports as sensitive. They intentionally exclude secrets, but they can
contain complete conversation history, long-term memory, source documents,
embeddings, system prompts, seed messages, reviewed training examples,
consent records, JSONL snapshots, and model-building metadata.

## Fine-Tuning Studio and trainer ownership

Training is disabled by default. Configure it in Fine-Tuning Studio or with
`SOVEREIGN_TRAINER_URL` and `SOVEREIGN_TRAINER_TOKEN`. Loopback is the safe
default. A non-loopback URL requires the explicit remote-endpoint setting and
HTTPS, unless the operator separately acknowledges insecure HTTP. The complete
approved train/eval snapshot crosses that boundary; this is materially more
data than retrieval usually sends.

The application does not install a trainer or call a hosted/OpenAI fine-tuning
service. Operate a compatible trainer using the
[`sovereignai.trainer/v1` contract](../integrations/trainer/README.md). Cache
base models before offline training, disable framework telemetry and remote
loggers, mount approved datasets read-only where practical, and isolate the
artifact directory. Check accelerator memory, host memory, free disk, base
model license, and exact model revision before starting.

Source consent records the canonical trainer endpoint disclosed during
curation; run consent records the current endpoint, immutable dataset hash,
method, and normalized hyperparameters. If the endpoint changes, a fresh run
confirmation is required and recorded. An unreachable job is indeterminate,
not failed: it blocks duplicate runs and **Refresh** retries the same
idempotency key. Confirm terminal state with the trainer before cleaning up.

For one-click persona assignment, the trainer must already have registered a
merged GGUF model at the same Ollama endpoint configured in SovereignAI and
must attest to that tag's digest. SovereignAI compares the live Ollama digest
before changing the persona. It does not upload GGUF bytes itself. See the
[guided workflow and retention details](FINE_TUNING.md).

## Model Studio builds and endpoint ownership

A Model Studio recipe is a local SQLite record containing the artifact name,
base model, system prompt, parameters, template, license, quantization, and
optional seed messages. Saving a recipe does not contact a provider. Building
it sends the required specification to `/api/create` at the Ollama URL in the
active SovereignAI configuration.

The recipe's license field records terms to carry into the artifact; it does
not grant rights to the base model or replace its third-party license. Check
the source model's use and redistribution terms. Quantization is supported only
for eligible FP16/FP32 source models; if the source or requested format is not
eligible, correct the recipe or source rather than assuming the build changed
the weights successfully. A quantized build leaves the source model unchanged
but creates a derived artifact whose weights use the requested lower-precision
representation.

Before a build, verify the endpoint shown by Model Studio:

- A local endpoint keeps the build request and resulting artifact on the
  machine or container environment you operate.
- A remote endpoint receives the recipe inputs and stores the artifact on that
  remote system. Use an authenticated, encrypted connection and an endpoint
  whose retention and access controls you trust.

The build response includes the generated Modelfile and ownership metadata so
the UI can state this boundary accurately. SovereignAI does not upload the
artifact to a project-owned service, mirror its weights, or retain a second
hidden copy.

“Build model” means package a base model with configurable inference behavior
and metadata. It does **not** change the base model's weights, train on workspace
content, or perform fine-tuning. The only workspace content sent during this
operation is content explicitly placed in the recipe, such as the system prompt
or seed messages.

## Upgrading from v0.2

### Installed launcher

The v0.2 launcher stored state relative to the directory from which it was
invoked. The v0.3 installer uses the stable home listed above, so an upgrade
can look like an empty workspace even though the old files still exist.

Before the first v0.3 launch, stop SovereignAI and find the old directory that
contains `sovereign.config.json` and `data/sovereign.db`. Back it up, then use
one of these approaches:

- Keep using it by setting `SOVEREIGN_HOME` to that old directory before each
  launch (or in your shell profile).
- Copy `sovereign.config.json` and the complete `data/` directory into
  `%LOCALAPPDATA%\SovereignAI` on Windows or `~/.sovereignai` on macOS/Linux.

Do not copy a live SQLite database. After migration, run
`sovereign doctor --no-network` and confirm the expected record counts before
removing the backup.

### Docker

v0.2 persisted `data/` in the `sovereign-data` volume, but its
`/app/sovereign.config.json` lived only in the container layer. While the v0.2
container still exists, copy the settings out **before** `docker compose down`:

```bash
docker compose cp sovereign:/app/sovereign.config.json ./sovereign.config.v0.2.json
```

That backup contains live provider keys and bearer tokens. The filename above
is Git-ignored by this repository, but still keep it owner-readable only,
avoid source-controlled directories elsewhere, and delete it after the
migration is verified.

Start v0.3 with a retained token as shown below, then restore and reload the
settings:

```bash
docker compose cp ./sovereign.config.v0.2.json sovereign:/state/sovereign.config.json
docker compose restart sovereign
```

The old `sovereign-data` database volume is mounted automatically at
`/state/data`. If v0.2 used Ollama on the Docker host, set
`OLLAMA_BASE_URL=http://host.docker.internal:11434`; v0.3 otherwise defaults to
the containerized `ollama` profile service. After this one-time migration,
`sovereign-state` persists settings and `sovereign-data` persists the database.

## Single-binary installs

Each release attaches self-contained executables built with Node's single
executable application support: `sovereign-v<version>-win-x64.exe`,
`-macos-arm64`, and `-linux-x64`. They embed the Node runtime, the unmodified
SovereignAI source modules, and the web UI — nothing to install, nothing else
to download, fully offline-capable.

- **Home:** same stable location as the installers (`%LOCALAPPDATA%\SovereignAI`
  or `~/.sovereignai`); `SOVEREIGN_HOME` overrides it. A binary and an
  installed launcher on the same machine share one workspace by default.
- **Upgrade:** replace the file. Downgrades follow the same state rules as any
  other install ([see the migration section](#upgrading-from-v02)).
- **First launch:** binaries are not store-signed (macOS builds are ad-hoc
  signed), so Windows SmartScreen or macOS Gatekeeper may ask for a one-time
  confirmation (macOS: right-click → Open, or
  `xattr -d com.apple.quarantine <file>`). Checksums for verification come
  from the GitHub Release page.
- **Reproduce locally:** `node scripts/build-sea.mjs` on the target platform
  (Node 22.15+; fetches the `postject` injector at build time only) produces
  the same artifact in `dist/` and runs a version/doctor/live-server smoke
  test against it.

## Docker and Ollama

Generate, display, and retain one token before starting. Save the printed URL
in a password manager, or put the same `SOVEREIGN_TOKEN=...` value in the
Git-ignored `.env` file for later container recreation.

```bash
# macOS/Linux
export SOVEREIGN_TOKEN="$(openssl rand -hex 24)"
echo "Save this URL: http://localhost:4321/#token=$SOVEREIGN_TOKEN"
docker compose --profile ollama up -d
docker compose exec ollama ollama pull llama3.1
docker compose exec ollama ollama pull nomic-embed-text
```

```powershell
# Windows PowerShell
$env:SOVEREIGN_TOKEN = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
Write-Host "Save this URL: http://localhost:4321/#token=$env:SOVEREIGN_TOKEN"
docker compose --profile ollama up -d
```

If the startup URL is lost while the container is still running,
`docker compose logs sovereign` shows the URL printed at startup. Treat those
local logs as secret-bearing.

To use an Ollama process already running on the Docker host, omit the profile
and set its URL before starting:

```bash
export OLLAMA_BASE_URL=http://host.docker.internal:11434
docker compose up -d
```

Plain HTTP exposes bearer tokens, prompts, and retrieved context to network
observers. Use HTTP only on a trusted local network or encrypted overlay such
as a tailnet; terminate HTTPS before exposing the service elsewhere.
