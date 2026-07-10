# Operations

## State and instances

An installed `sovereign` launcher uses one stable home, independent of the
terminal's current directory:

- Windows installer: `%LOCALAPPDATA%\SovereignAI`
- macOS/Linux installer: `~/.sovereignai`
- Docker: `/state`

The home contains `sovereign.config.json` and `data/sovereign.db`. Set
`SOVEREIGN_HOME` explicitly to select another instance. Running the source
directly without that variable remains project-local and uses the current
directory.

Use `sovereign doctor` to check the active home, configuration, database
integrity/counts, provider connectivity, and selected chat/embedding models.
It never prints bearer tokens or provider API keys. For a local-only check:

```bash
sovereign doctor --no-network
```

The command exits non-zero when it finds a failure, making it suitable for
smoke checks.

JSON exports restore personas, conversations, messages, memories, documents,
and chunks. Provider URLs, model defaults, bearer tokens, and API keys must be
reconfigured separately. Export files contain private workspace content and
are created with owner-only permissions on POSIX systems when written by the
`sovereign export` CLI. Browser downloads follow the browser and operating
system's download permissions.

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
