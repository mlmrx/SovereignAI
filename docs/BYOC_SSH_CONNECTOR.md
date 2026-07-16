# BYOC rail #1 — Deploy to a Docker host over SSH

> **Status: implemented** (v0.4.0) as `sovereign byoc` — `src/byoc/`
> (ssh runner · registry · connector), covered by `test/byoc.test.js`.
>
> ```
> sovereign byoc deploy --host you@your-box     # shows the full plan; --yes applies it
> sovereign byoc list | status <name>           # registry / live health
> sovereign byoc upgrade <name>                 # health-verified swap, auto-rollback
> sovereign byoc export <name> [file]           # stream your data to YOUR machine
> sovereign byoc suspend|resume <name>
> sovereign byoc destroy <name> --yes [--purge-data]   # verifiable removal
> ```
>
> Implementation choices worth knowing (deliberate deviations from the sketch
> below):
>
> - **SSH transport is the platform OpenSSH client** (spawned, never bundled) —
>   zero runtime npm dependencies holds. Host keys are pinned into
>   `<home>/byoc/known_hosts` on first contact and strictly required afterward.
> - **The token never transits the control plane** (the stretch goal shipped):
>   it is generated from `/dev/urandom` *on the host*, stored 0600 there, and
>   health probes run *over the SSH rail*, sourcing the token host-side and
>   crossing only the host's own loopback. It is read back exactly once — to
>   print the owner's authenticated URL — and only its SHA-256 lands in the
>   registry. The env file is owned by the deploy user, not root: we don't
>   require root, so requiring a root-owned file would contradict ourselves.
> - **Default image path is "build from your committed source on your host"**
>   (`git archive HEAD` streamed into `docker build -`): auditable,
>   reproducible from a commit hash, and it works while the repo/GHCR image is
>   private. `--image <ref>` pulls a published image instead.
> - **Container hardening at run time:** `--read-only` rootfs + `--tmpfs /tmp`,
>   `--security-opt no-new-privileges`, non-root app user (from the image),
>   loopback bind by default (`--bind lan` to expose, token-protected).
> - **Deploy is plan-first:** the exact `docker run`, image source, and env
>   *keys* print before anything executes; `--yes` applies.
> - Step 5's multi-account control panel is **not** in this rail; the registry
>   (`<home>/byoc/instances.json`, metadata + token hash only) is the
>   control-plane record, and the CLI is the handoff UI.

The first "bring-your-own-infrastructure" connector. It proves the whole
control-plane / data-plane model with the smallest possible surface: the user
brings a Linux box they own (a VPS, Hetzner, a homelab, on-prem — anything with
SSH and Docker), and SovereignAI's control plane deploys and manages an
isolated instance **there**, in infrastructure the user owns and we never
possess the disk of.

If this rail works, every richer target (AWS ECS, Fly.io, GCP) is the same
orchestrator with a different driver. Start here.

## What "sovereign" means for this rail, precisely

- The data plane (app, SQLite, documents, memory, keys) lives **only** on the
  user's host. We never mount, copy, or back up their volume.
- The control plane holds **connection metadata and health status**, never
  customer content. It knows "instance is up, version 0.3.0"; it never sees a
  chat or a document.
- Every action we take on their box is done over an SSH credential **they
  grant** and can revoke. Revoking the key ends our access completely.
- What we push (image tag + env) is **inspectable and reproducible** — the user
  can see and audit every change before it applies. Supply-chain trust is
  earned by transparency, not asserted.

This is genuinely sovereign-in-storage: we cannot read what never leaves their
machine. It is honest to call it that, unlike a we-host-it managed instance.

## Reuse, don't reinvent — the deploy contract already exists

The app is already a clean single-tenant data plane. The connector needs no
app changes; it drives the existing container contract:

| Seam (already in the repo) | The connector uses it for |
|---|---|
| `Dockerfile` / `ghcr.io` image | the exact artifact to run on their host |
| `SOVEREIGN_TOKEN` env | the instance boundary credential (per-instance secret) |
| `SOVEREIGN_HOME=/state` + `VOLUME /state` | the user-owned data volume |
| `SOVEREIGN_HOST` / `SOVEREIGN_PORT` | bind/port |
| `OLLAMA_BASE_URL` / `OPENAI_*` / `ANTHROPIC_*` | the user's own provider choice |
| `GET /api/status` (+ `HEALTHCHECK`) | health metadata polling |
| `sovereign export` | the exit path, triggerable per instance |

Env-var-only configuration is the whole reason this rail is thin.

## Preconditions we require of the user's host

The connector checks these first and fails loudly (never half-deploys):

- SSH reachable; the key we're given authenticates.
- A non-root user with Docker permission (we do **not** require root).
- Docker Engine present (offer a guided `get.docker.com` step if absent, with
  explicit consent — installing software on their box is their call).
- Outbound network to pull the image (or an air-gapped path: `docker load` a
  tarball we transfer).
- A place for the state volume with enough disk.

## The provisioning sequence (control plane → their host)

```
1. CONNECT      open an SSH session with the user-granted key; run preflight checks
2. PREFLIGHT    verify docker, non-root docker access, disk, arch, outbound net
3. SECRETS      generate a per-instance SOVEREIGN_TOKEN (32 bytes) ON their host;
                write it to a root-owned .env with 0600 perms. The control plane
                stores only a HASH of it for health calls, never the plaintext
                on our side longer than the request. (Stretch: the token is
                generated host-side and never transits our control plane at all.)
4. HARDEN       run the container: non-root user, read-only rootfs where
                possible, no host IAM/metadata exposure, bind 127.0.0.1 + a
                reverse proxy the user controls for TLS — or bind LAN behind the
                token if that's their choice. (Ships with the data-plane
                hardening: SSRF host-blocking + redirect:manual — see below.)
5. RUN          docker run/compose the pinned image with the env contract and the
                /state volume on their disk
6. VERIFY       poll GET /api/status with the token until healthy; record
                version + instance id
7. REGISTER     store in the control plane: { instanceId, sshTarget (ref, not
                key), publicUrl, tokenHash, version, ownerAccount }. No content.
8. HANDOFF      give the user their authenticated URL (#token=…) and the
                one-line "how to revoke us" instructions
```

Lifecycle actions reuse the same SSH rail:

- **upgrade** → pull new pinned tag, `docker compose up -d`, health-verify,
  auto-rollback to the previous tag on failed health.
- **export** → run `sovereign export` in the container, stream the file to the
  *user* (never to us).
- **suspend / delete** → stop the container; delete removes the container and,
  only on explicit confirmation, the /state volume. Deletion is verifiable:
  we show the user the box is empty.
- **health** → periodic `GET /api/status` (metadata only).

## Security posture (this rail specifically)

- **No app secrets on our side.** We hold an SSH connection reference and a
  token *hash*. Losing our control plane cannot decrypt their data.
- **User can sever us instantly** by removing the SSH key — designed in, not a
  footnote.
- **Data-plane hardening is a hard prerequisite** and ships before this rail is
  offered publicly (these are in-repo fixes, independent of the connector):
  - SSRF: block link-local / metadata (169.254.0.0/16) / private ranges in
    provider `baseUrl` unless explicitly opted in; `redirect: 'manual'` on
    provider fetches. **Critical** — a customer-owned box may still sit in a
    cloud with a metadata endpoint.
  - Container runs as a non-root user.
  - HSTS header once always-TLS.
- **What we push is auditable.** The image tag is pinned and content-addressed;
  the env is shown to the user before apply. No silent updates.

## Explicitly out of scope for rail #1

TLS/domain automation (user brings their own reverse proxy or we add it as
rail 1.5), multi-region, GPU scheduling, and the per-cloud drivers (AWS/GCP/
Fly). Those are later rails that reuse this orchestrator's shape.

## Build order

1. **Data-plane hardening** (SSRF block + redirect:manual + non-root container).
   Needed under every path; smallest, highest-value, already in the audit.
2. **Preflight + connect** — SSH reachability and host capability checks, with
   clear failures. (Prove we can safely touch a user box before we deploy to
   it.)
3. **Provision + verify** — the run + health-poll loop against the existing
   `/api/status`.
4. **Lifecycle** — upgrade/rollback, export-to-user, verifiable delete.
5. **Control-plane record + handoff UI** — accounts come in here, authenticating
   to the control panel (not to customer data).

Ship 1 immediately (it's independent and the audit calls it critical); 2–3 are
the MVP of "you pick the infra"; 4–5 make it a product.
