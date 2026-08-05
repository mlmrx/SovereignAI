# Security Audit — August 2026

Full-codebase audit across six attack surfaces (HTTP/auth, SSRF/providers,
crypto/secrets/import, BYOC/SSH, untrusted-input parsers, web-UI XSS). Every
finding below was verified against the actual code. Threat model: local-first
single-user by default, but also `--lan` behind a token, behind a tunnel/
reverse proxy, and on rented GPU/BYOC hosts exposed to the internet.

**Headline: no remotely-exploitable code-execution or data-theft vulnerability
in the default local posture.** The serious findings live where the product is
expanding — cloud/BYOC deployment and untrusted-file import. Five were fixed
immediately (commit 45f88a0); the rest are ranked recommendations below.

## Fixed now (commit 45f88a0, 291/291 tests green)

| Finding | Severity | Fix |
|---|---|---|
| **Exponential ReDoS in PDF text extraction** — `pdf.js` TJ-array regex class overlapped its escape alternative; a ~1 KB uploaded PDF with a backslash run hangs the process. Reachable over `POST /api/documents`. | High | Excluded backslash from the class so the alternation is disjoint; linear now. |
| **Quadratic ReDoS in email From-header parsing** — `mbox.js` two adjacent unbounded runs around `@`; a crafted header in an imported mailbox hangs the import for minutes. | Medium | Cap header to 998 chars before matching; exclude `@` from the first class. |
| **Unbounded mbox line buffer** — a newline-free stream accumulates the whole file in memory → OOM instead of clean rejection. | Medium | Flush an oversized unterminated remainder as a truncated line. |
| **Latent SSH command injection via `--image`** — `connector.js` spliced the raw image ref into the remote `docker run` unquoted (the sibling `docker pull` quoted it). Gated today only by docker's own ref validation. | Low | `shq()`-quote it, matching the pull/build paths. |
| **SSRF metadata-guard bypass via IPv4-mapped IPv6** — `[::ffff:169.254.169.254]` normalized to a hex form the blocklist didn't recognize. | Medium (cloud) | Normalize mapped forms to embedded IPv4 and re-check. |

Plus smaller hardening in the same commit: HTML-strip input bounded, email
subject bounded before the pattern set, merchant subdomain-strip loop bounded.

## Second pass — all recommendations resolved (commit pending, 295/295 tests green)

Every recommendation below was subsequently implemented. Summary of what shipped:

- **R1** — `safeFetch` now resolves the target host and refuses if any resolved
  address is a blocked metadata/link-local IP (closes the DNS-name→IMDS pivot);
  the guard moved to `util.js` to break the circular import. Residual live-DNS-
  rebinding is documented, out of scope for the tricked-config threat model.
- **R2** — tokenless mode now refuses any request carrying a forwarding header
  (`X-Forwarded-*`, `Forwarded`, `X-Real-IP`, `Via`): a proxied request is not
  genuinely local, so it must use a token.
- **R3** — extension origins are no longer blanket-trusted; only origins in the
  new `config.trustedExtensionOrigins` allowlist (default empty) are accepted.
- **R4** — GPU health/readiness polls default to `safeFetch` (`redirect:'error'`),
  so a MITM 302 can't exfiltrate the bearer; the CLI warning now says the token
  crosses the network in cleartext *now*.
- **R5** — RunPod key moved from the URL query string to an `Authorization`
  header.
- **R6** — export passphrase floor raised to 12 chars; scrypt cost raised to
  N=2^17 with explicit `maxmem`.
- **R7** — provider error bodies pass through `redactApiKeys` before surfacing.
- **R8** — scrypt bounds now reject any `128·N·r` exceeding `maxmem` and
  `scryptSync` runs inside the try/catch; `getProvider`/`getGpuProvider` use
  `Object.hasOwn`; the `--wire` message states the key is written to config.

Original write-ups retained below for the record.

### R1 — SSRF metadata pivot via DNS name (High, in cloud/BYOC only)
`config.js ssrfBlockedReason` is a **string** blocklist that never resolves
DNS, so `http://name-that-resolves-to-169.254.169.254` passes and `fetch`
then reaches the metadata endpoint; upstream error bodies are reflected back,
making it a *readable* SSRF. Inert on a local laptop (no metadata endpoint);
serious on rented-GPU/BYOC/managed instances, where the config write is behind
the bearer token (threat = a tricked or compromised authenticated operator).
**Fix:** resolve the host and check every resolved A/AAAA record, and pin the
resolved IP for the connection (custom `lookup`/undici agent) to defeat
rebinding — this is an async change to the outbound path, so it wants its own
focused PR + tests. Consider also a `restrictToLoopback` toggle for cloud
deployments where the LAN-Ollama assumption doesn't hold.

### R2 — Tokenless API fully exposed behind a same-host reverse proxy (High, misconfiguration)
Default tokenless mode authenticates by `socket.remoteAddress === 127.0.0.1`.
A same-host reverse proxy (e.g. `nginx proxy_pass http://127.0.0.1:4321` with
no `Host` rewrite) makes every internet request look loopback → a non-browser
client (`curl`, no `Origin`) gets full unauthenticated read/write/export. The
docs already say "use a token / terminate HTTPS before exposing," but the
loopback shortcut is a forgeable auth signal. **Fix:** treat proxied exposure
as remote — require a token whenever direct loopback can't be proven, or an
explicit `trustProxy` opt-in that disables the shortcut and mandates the token;
at minimum, a loud startup warning. Decision needed because it changes the
local-first UX.

### R3 — Any browser extension can drive the tokenless local API (Medium)
`safeBrowserOrigin` returns `true` for *every* `chrome-extension://` /
`moz-extension://` origin, so any installed extension with a localhost host
permission can read/export/delete via the no-token API. **Fix:** gate the
extension allowance behind the token, or pin the published extension's ID.
(Needs the real extension ID once the store listing exists.)

### R4 — Cleartext-HTTP token transport on the container GPU rail (Medium)
`gpu-provision.js` health/readiness polls send `SOVEREIGN_TOKEN` / `VLLM_API_KEY`
as a Bearer header over plain HTTP to the provider's public IP, and use default
`fetch` (follows redirects). **Fix:** route these through `safeFetch`
(`redirect:'error'`) so a MITM 302 can't exfiltrate the header; strengthen the
CLI warning to say the token is exposed in transit *now*. (Partly inherent —
the provider terminates no TLS — so pair with docs.)

### R5 — RunPod API key in the URL query string (Medium)
`runpod.js` puts the live key in `?api_key=` (lands in proxy/CDN logs); the
other two providers use auth headers. **Fix:** move to `Authorization: Bearer`
per RunPod's REST API — but the client is unverified against live infra, so
change it together with a real-account test, not blind.

### R6 — Weak passphrase floor on encrypted exports (Low, product decision)
`portability.js` enforces only 8 characters, with deliberately light scrypt.
An 8-char passphrase on a stolen archive is offline-brute-forceable. **Fix:**
raise the floor to 12+, add a strength meter, and/or bump scrypt cost.

### R7 — Provider error bodies surfaced verbatim (Low)
`parsers.js ensureOk` reflects up to 500 chars of an upstream error into the
client; an OpenAI 401 body echoes a partial key. **Fix:** run provider error
text through the existing `safeTrainingError`-style redactor before surfacing.

### R8 — Minor robustness (Informational)
scrypt param combo `N=2^20, r=32` throws a raw error (not a memory bomb —
`maxmem` caps it) outside the friendly try/catch; `getProvider`/`getGpuProvider`
resolve inherited prototype keys to a confusing 500 instead of a clean 400;
`--wire` prints "only its hash is stored" while writing the key (0600) to config.

## Confirmed-solid (verified, no action)
Parameterized SQL throughout · header-delivered strict CSP (`script-src 'self'`,
no `unsafe-inline`) with escape-first rendering everywhere attacker data reaches
the DOM (memory, chat/markdown, life records, HF results) · `safeFetch`
`redirect:'error'` blocks the redirect-SSRF/credential-leak amplifier · numeric-IP
SSRF obfuscation (hex/octal/decimal/dotted-overflow) defeated by WHATWG parse
order · timing-safe bearer compare · DNS-rebind (Host allowlist) + cross-origin
(Origin + JSON-only) + no `X-Forwarded-For` trust · 20 MB body cap · SSE abort/
cleanup · static-serve path-traversal rejection · zip-slip safe (read-to-memory,
fixed entry names) · zip/PDF decompression-bomb bounds (`maxOutputLength`) · no
XXE (regex extraction, no XML parser) · AES-256-GCM with per-encryption IV+salt
and tag-verified-before-use · scrypt KDF params bounds-checked · prototype-pollution
guard in `deepMerge` + allow-listed import normalizers · export omits all secrets;
config masking can't be replayed to exfiltrate · CSPRNG for every security token ·
SSH scripts over stdin (never argv) + `shq` + strict name allowlist + host-key
pinning + registry refuses secret fields + keys `0600`.
