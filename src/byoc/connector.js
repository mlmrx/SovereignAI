import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../config.js';
import { shq } from './ssh.js';
import { assertInstanceName, openRegistry } from './registry.js';

// BYOC rail #1: deploy SovereignAI onto a Docker host the user owns, over
// SSH. The data plane (SQLite, documents, keys) lives only on their machine;
// this module holds connection metadata and health facts, nothing more.
//
// Every remote step is a POSIX-sh script piped over `ssh <host> sh -s`
// (stdin), so no user-controlled value is ever interpolated into an ssh
// argument list, and the instance token is generated ON the host and read
// back exactly once — for the owner's handoff URL — never persisted here.

const HEALTH_TIMEOUT_MS = 120_000;
const HEALTH_POLL_MS = 2_000;
const IMAGE_TIMEOUT_MS = 15 * 60_000;
const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const MIN_DISK_KB = 1024 * 1024; // 1 GiB
const COMFY_DISK_KB = 5 * 1024 * 1024; // 5 GiB

export class ByocError extends Error {
  constructor(message, { failures = [] } = {}) {
    super(message);
    this.name = 'ByocError';
    this.failures = failures;
  }
}

export function containerName(name) {
  return `sovereign-${assertInstanceName(name)}`;
}

export function volumeName(name) {
  return `sovereign-${assertInstanceName(name)}-state`;
}

export function remoteDir(name) {
  return `.sovereignai/${assertInstanceName(name)}`;
}

// ---------------------------------------------------------------------------
// Preflight: prove we can safely touch the box before we deploy to it.
// ---------------------------------------------------------------------------

export function preflightScript({ registryHost = 'registry-1.docker.io', port = 4321 } = {}) {
  const probe = `https://${registryHost}/v2/`;
  return `set -u
printf 'os=%s\\n' "$(uname -s 2>/dev/null || echo unknown)"
printf 'arch=%s\\n' "$(uname -m 2>/dev/null || echo unknown)"
printf 'uid=%s\\n' "$(id -u 2>/dev/null || echo unknown)"
printf 'user=%s\\n' "$(id -un 2>/dev/null || echo unknown)"
if command -v docker >/dev/null 2>&1; then
  printf 'docker_cli=yes\\n'
  err=$(mktemp 2>/dev/null || echo /tmp/sovereign-preflight.$$)
  server=$(docker version --format '{{.Server.Version}}' 2>"$err") || true
  if [ -n "\${server:-}" ]; then
    printf 'docker_server=%s\\n' "$server"
  else
    printf 'docker_server=\\n'
    printf 'docker_error=%s\\n' "$(tr '\\n' ' ' <"$err" | head -c 300)"
  fi
  rm -f "$err"
else
  printf 'docker_cli=no\\n'
fi
printf 'disk_avail_kb=%s\\n' "$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2 {print $4}')"
if command -v curl >/dev/null 2>&1; then
  code=$(curl -s -o /dev/null --max-time 8 -w '%{http_code}' ${shq(probe)} 2>/dev/null || printf 000)
  if [ "$code" = "000" ]; then printf 'outbound=no\\n'; else printf 'outbound=yes\\n'; fi
elif command -v wget >/dev/null 2>&1; then
  wget -q --timeout=8 --spider ${shq(probe)} 2>/dev/null
  rc=$?
  if [ "$rc" -eq 0 ] || [ "$rc" -eq 6 ] || [ "$rc" -eq 8 ]; then printf 'outbound=yes\\n'; else printf 'outbound=no\\n'; fi
else
  printf 'outbound=unknown\\n'
fi
if command -v ss >/dev/null 2>&1; then
  if ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq '[:.]${Number(port)}$'; then printf 'port_in_use=yes\\n'; else printf 'port_in_use=no\\n'; fi
else
  printf 'port_in_use=unknown\\n'
fi
`;
}

export function parsePreflight(text) {
  const report = {};
  for (const line of String(text).split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) report[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return report;
}

/** Pure verdict over a preflight report; never half-deploys on failure. */
export function evaluatePreflight(report, { port = 4321, imageMode = 'source' } = {}) {
  const failures = [];
  const warnings = [];

  if (report.os !== 'Linux') {
    failures.push(`Host OS is "${report.os ?? 'unknown'}"; rail #1 deploys to Linux Docker hosts.`);
  }
  if (report.arch && !['x86_64', 'aarch64', 'arm64'].includes(report.arch)) {
    warnings.push(`Host architecture "${report.arch}" is untested; the image targets amd64/arm64.`);
  }
  if (report.uid === '0') {
    warnings.push('Connected as root. This works, but a non-root user in the docker group is the recommended posture.');
  }
  if (report.docker_cli !== 'yes') {
    failures.push('Docker is not installed on the host. Install it yourself (e.g. https://get.docker.com) — installing software on your box is your call, so we never do it for you.');
  } else if (!report.docker_server) {
    const detail = report.docker_error ?? '';
    if (/permission denied/i.test(detail)) {
      failures.push(`The SSH user "${report.user ?? '?'}" cannot use Docker (permission denied). Add it to the docker group: sudo usermod -aG docker ${report.user ?? '<user>'}`);
    } else {
      failures.push(`Docker is installed but the daemon is not reachable${detail ? ` (${detail.trim()})` : ''}.`);
    }
  }
  const diskKb = Number(report.disk_avail_kb);
  if (Number.isFinite(diskKb) && diskKb > 0) {
    if (diskKb < MIN_DISK_KB) failures.push(`Only ${Math.round(diskKb / 1024)} MiB free on the host; at least 1 GiB is required.`);
    else if (diskKb < COMFY_DISK_KB) warnings.push(`${(diskKb / 1024 / 1024).toFixed(1)} GiB free on the host; 5+ GiB is recommended once documents accumulate.`);
  } else {
    warnings.push('Could not determine free disk space on the host.');
  }
  if (report.outbound === 'no') {
    const need = imageMode === 'pull' ? 'pull the SovereignAI image' : 'pull the node:22-alpine base image';
    if (imageMode === 'pull') failures.push(`The host has no outbound access to the registry, so it cannot ${need}.`);
    else warnings.push(`The host could not reach the registry; the build will fail unless node:22-alpine is already cached locally.`);
  }
  if (report.port_in_use === 'yes') {
    failures.push(`Port ${port} is already listening on the host; choose another with --port.`);
  }

  return { ok: failures.length === 0, failures, warnings };
}

export async function preflight(runner, { port = 4321, imageMode = 'source', registryHost } = {}) {
  const probeHost = registryHost ?? (imageMode === 'pull' ? 'ghcr.io' : 'registry-1.docker.io');
  const result = await runner.exec('sh -s', { stdin: preflightScript({ registryHost: probeHost, port }) });
  if (result.code !== 0 && !result.stdout.trim()) {
    throw new ByocError(`Could not run the preflight on ${runner.describe()}: ${firstLine(result.stderr) || `ssh exited ${result.code}`}`);
  }
  const report = parsePreflight(result.stdout);
  return { report, verdict: evaluatePreflight(report, { port, imageMode }) };
}

// ---------------------------------------------------------------------------
// Provision: token on their host, hardened container, health-verified.
// ---------------------------------------------------------------------------

/**
 * Create the instance directory and env file on the host. The
 * SOVEREIGN_TOKEN is generated on THEIR machine from /dev/urandom and written
 * 0600; it never transits the control plane during provisioning. Extra env
 * (provider endpoints/keys the user chose) is upserted line-by-line.
 */
export function ensureEnvScript(name, env = {}) {
  const dir = remoteDir(name);
  const lines = [
    'set -eu',
    'umask 077',
    `dir="$HOME/${dir}"`,
    'mkdir -p "$dir"',
    'cd "$dir"',
    'if [ ! -f env ]; then',
    `  token=$(head -c 32 /dev/urandom | od -An -v -tx1 | tr -d ' \\n')`,
    '  [ -n "$token" ] || { echo "token generation failed" >&2; exit 1; }',
    `  printf 'SOVEREIGN_TOKEN=%s\\n' "$token" > env`,
    'fi',
    'chmod 600 env',
    'upsert() {',
    '  grep -v "^$1=" env > env.tmp || true',
    `  printf '%s=%s\\n' "$1" "$2" >> env.tmp`,
    '  mv env.tmp env',
    '  chmod 600 env',
    '}',
  ];
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY_PATTERN.test(key)) throw new ByocError(`Invalid env key "${key}": use UPPER_SNAKE_CASE`);
    if (/[\r\n\0]/.test(String(value))) throw new ByocError(`Invalid env value for "${key}": newlines are not allowed`);
    lines.push(`upsert ${shq(key)} ${shq(String(value))}`);
  }
  lines.push(`printf 'env=ready\\n'`);
  return `${lines.join('\n')}\n`;
}

/**
 * The exact container we run — one construction shared by deploy and
 * upgrade so what the user audited is always what executes. Hardened:
 * read-only rootfs, no privilege escalation, loopback bind by default
 * (the user's reverse proxy terminates TLS), state in a named volume on
 * their disk.
 */
export function dockerRunCommand({ name, bind, port, imageRef }) {
  const address = bind === 'lan' ? '0.0.0.0' : '127.0.0.1';
  return [
    'docker run -d',
    `--name ${containerName(name)}`,
    '--restart unless-stopped',
    '--read-only',
    '--tmpfs /tmp',
    '--security-opt no-new-privileges',
    `--env-file "$HOME/${remoteDir(name)}/env"`,
    `-p ${address}:${Number(port)}:4321`,
    `-v ${volumeName(name)}:/state`,
    imageRef,
  ].join(' ');
}

/** Health probe that keeps the token host-side: sourced from the env file on
 * their box, sent only across their own loopback into the container. */
export function healthScript(name) {
  return `set -eu
cd "$HOME/${remoteDir(name)}"
. ./env
exec docker exec ${containerName(name)} wget -qO- -T 5 --header="Authorization: Bearer $SOVEREIGN_TOKEN" http://127.0.0.1:4321/api/status
`;
}

function readTokenScript(name) {
  return `set -eu
. "$HOME/${remoteDir(name)}/env"
printf %s "$SOVEREIGN_TOKEN"
`;
}

async function pollHealth(runner, name, { timeoutMs = HEALTH_TIMEOUT_MS, sleep = defaultSleep, log = noop } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response yet';
  for (;;) {
    const result = await runner.exec('sh -s', { stdin: healthScript(name), timeoutMs: 20_000 }).catch((err) => ({ code: -1, stdout: '', stderr: err.message }));
    if (result.code === 0) {
      try {
        const status = JSON.parse(result.stdout);
        if (status && typeof status.version === 'string') return status;
        lastError = 'status endpoint returned unexpected JSON';
      } catch {
        lastError = 'status endpoint returned non-JSON output';
      }
    } else {
      lastError = firstLine(result.stderr) || `probe exited ${result.code}`;
    }
    if (Date.now() >= deadline) throw new ByocError(`Instance did not become healthy: ${lastError}`);
    log(`  waiting for health… (${lastError})`);
    await sleep(HEALTH_POLL_MS);
  }
}

async function containerLogs(runner, name) {
  const result = await runner.exec(`docker logs --tail 40 ${containerName(name)} 2>&1 | tail -c 4000`).catch(() => null);
  return result?.stdout?.trim() ?? '';
}

/** Resolve the image on the host: pull a pinned ref, or (default) stream the
 * committed source tree into `docker build` there — fully auditable, and it
 * works before any public registry image exists. */
async function resolveImage(runner, { image, archive, log }) {
  if (image.mode === 'pull') {
    if (!image.ref || typeof image.ref !== 'string') throw new ByocError('Pull mode needs an image reference: --image ghcr.io/owner/sovereignai:tag');
    log(`• Pulling ${image.ref} on the host…`);
    const result = await runner.exec(`docker pull ${shq(image.ref)}`, { timeoutMs: IMAGE_TIMEOUT_MS });
    if (result.code !== 0) throw new ByocError(`docker pull failed: ${lastLine(result.stderr) || lastLine(result.stdout)}`);
    return { ref: image.ref, commit: null };
  }
  const { tar, commit, ref } = await archive();
  log(`• Building ${ref} on the host from commit ${commit.slice(0, 12)} (${formatBytes(tar.length)} source context)…`);
  const result = await runner.exec(`docker build -t ${shq(ref)} -`, { stdin: tar, timeoutMs: IMAGE_TIMEOUT_MS });
  if (result.code !== 0) throw new ByocError(`docker build failed on the host: ${lastLine(result.stderr) || lastLine(result.stdout)}`);
  return { ref, commit };
}

/** The committed tree only (git archive HEAD): what deploys is reproducible
 * from a commit the user can read, not whatever happened to be on disk. */
export function sourceArchive(repoRoot = packageRoot()) {
  const rev = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
  if (rev.status !== 0) {
    throw new ByocError('Source-build mode needs a git checkout of SovereignAI (git rev-parse failed). Use --image <ref> to deploy a published image instead.');
  }
  const commit = rev.stdout.trim();
  return async () => {
    const tar = await new Promise((resolve, reject) => {
      const child = spawn('git', ['archive', '--format=tar', 'HEAD'], { cwd: repoRoot, windowsHide: true });
      const chunks = [];
      child.stdout.on('data', (chunk) => chunks.push(chunk));
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) resolve(Buffer.concat(chunks));
        else reject(new ByocError(`git archive exited ${code}`));
      });
    });
    return { tar, commit, ref: `sovereignai:${VERSION}-${commit.slice(0, 12)}` };
  };
}

/** Human-readable plan shown before anything executes: image source, the env
 * keys (never values), and the exact docker run command. */
export function deployPlan({ name, target, port, bind, image, envKeys = [] }) {
  const address = bind === 'lan' ? '0.0.0.0 (LAN — token-protected, TLS is on you)' : '127.0.0.1 (loopback; reach it via SSH tunnel or your reverse proxy)';
  return [
    `Instance   ${name}`,
    `Host       ${target}`,
    `Image      ${image.mode === 'pull' ? `pull ${image.ref}` : 'build on the host from your committed source (git archive HEAD)'}`,
    `Bind       ${address}, host port ${port}`,
    `State      docker volume ${volumeName(name)} (their machine, never copied to a control plane)`,
    `Secrets    SOVEREIGN_TOKEN generated on the host, stored 0600 in ~/${remoteDir(name)}/env${envKeys.length ? `; extra env: ${envKeys.join(', ')}` : ''}`,
    `Run        ${dockerRunCommand({ name, bind, port, imageRef: image.mode === 'pull' ? image.ref : `sovereignai:${VERSION}-<commit>` })}`,
  ].join('\n');
}

export async function deploy({
  rootDir,
  runner,
  name = 'main',
  port = 4321,
  bind = 'loopback',
  image = { mode: 'source' },
  env = {},
  archive,
  fingerprint = async () => null,
  log = noop,
  sleep = defaultSleep,
  healthTimeoutMs = HEALTH_TIMEOUT_MS,
} = {}) {
  assertInstanceName(name);
  if (!['loopback', 'lan'].includes(bind)) throw new ByocError(`Invalid --bind "${bind}": use loopback or lan`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ByocError(`Invalid port ${port}`);
  const registry = openRegistry(rootDir);
  if (registry.get(name)) {
    throw new ByocError(`Instance "${name}" already exists in the registry. Use "sovereign byoc upgrade ${name}", or destroy it first.`);
  }

  log(`• Preflight on ${runner.describe()}…`);
  const { report, verdict } = await preflight(runner, { port, imageMode: image.mode });
  for (const warning of verdict.warnings) log(`  ! ${warning}`);
  if (!verdict.ok) {
    throw new ByocError(`Preflight failed on ${runner.describe()} — nothing was deployed:\n  - ${verdict.failures.join('\n  - ')}`, { failures: verdict.failures });
  }
  log(`  ok: Linux/${report.arch}, docker ${report.docker_server}, ${(Number(report.disk_avail_kb) / 1024 / 1024).toFixed(1)} GiB free`);

  const guard = await runner.exec(`docker inspect --type container ${containerName(name)} >/dev/null 2>&1 && echo present || echo absent`);
  if (guard.stdout.trim() === 'present') {
    throw new ByocError(`A container named ${containerName(name)} already exists on the host. Destroy it or pick another --name.`);
  }
  if (guard.stdout.trim() !== 'absent') {
    throw new ByocError(`Could not inspect the host's containers: ${firstLine(guard.stderr) || 'unexpected ssh output'}`);
  }

  log('• Generating the instance token on the host (it stays there)…');
  const envResult = await runner.exec('sh -s', { stdin: ensureEnvScript(name, env) });
  if (envResult.code !== 0 || !envResult.stdout.includes('env=ready')) {
    throw new ByocError(`Could not prepare the instance env on the host: ${firstLine(envResult.stderr)}`);
  }

  const resolved = await resolveImage(runner, { image, archive: archive ?? sourceArchive(), log });

  log(`• Starting ${containerName(name)}…`);
  const run = await runner.exec(dockerRunCommand({ name, bind, port, imageRef: resolved.ref }));
  if (run.code !== 0) {
    throw new ByocError(`docker run failed: ${lastLine(run.stderr) || lastLine(run.stdout)}`);
  }

  log('• Verifying health…');
  let status;
  try {
    status = await pollHealth(runner, name, { timeoutMs: healthTimeoutMs, sleep, log });
  } catch (err) {
    const logs = await containerLogs(runner, name);
    await runner.exec(`docker rm -f ${containerName(name)} >/dev/null 2>&1 || true`).catch(() => {});
    throw new ByocError(`${err.message}\nThe container was removed so nothing is half-deployed (the ${volumeName(name)} volume and env were kept for a retry).${logs ? `\nLast container logs:\n${logs}` : ''}`);
  }
  log(`  healthy: SovereignAI v${status.version}`);

  // Handoff: read the token exactly once so the owner gets their
  // authenticated URL. We keep only its hash — enough to audit rotation,
  // useless for access.
  const tokenResult = await runner.exec('sh -s', { stdin: readTokenScript(name) });
  const token = tokenResult.code === 0 ? tokenResult.stdout.trim() : '';
  const tokenSha256 = token ? crypto.createHash('sha256').update(token).digest('hex') : null;

  const record = registry.save({
    name,
    createdAt: new Date().toISOString(),
    ssh: { target: runner.target, port: runner.sshPort, keyPath: runner.keyPath ?? null },
    hostKeyFingerprint: await fingerprint(),
    remoteDir: remoteDir(name),
    container: containerName(name),
    volume: volumeName(name),
    image: { mode: image.mode, ref: resolved.ref, commit: resolved.commit },
    bind: { address: bind === 'lan' ? '0.0.0.0' : '127.0.0.1', port },
    tokenSha256,
    app: { version: status.version, setupComplete: Boolean(status.setupComplete) },
    status: 'running',
    lastHealth: { at: new Date().toISOString(), ok: true, uptimeSeconds: status.uptimeSeconds ?? 0 },
  });

  return { record, status, handoff: buildHandoff({ runner, name, bind, port, token }) };
}

function buildHandoff({ runner, name, bind, port, token }) {
  const fragment = token ? `#token=${encodeURIComponent(token)}` : '';
  const portFlag = runner.sshPort === 22 ? '' : ` -p ${runner.sshPort}`;
  if (bind === 'lan') {
    return {
      url: `http://${runner.host}:${port}/${fragment}`,
      note: 'The instance is reachable on the LAN, protected by the bearer token. Put TLS in front before exposing it beyond a network you trust.',
      revoke: `To sever this control plane's access instantly: remove its key from ~/.ssh/authorized_keys on ${runner.host}. Your instance keeps running; only our reach ends.`,
    };
  }
  return {
    url: `http://127.0.0.1:${port}/${fragment}`,
    tunnel: `ssh${portFlag} -N -L ${port}:127.0.0.1:${port} ${runner.target}`,
    note: `The instance listens only on the host's loopback. Open the tunnel above (or point your own reverse proxy at 127.0.0.1:${port}), then use the URL.`,
    revoke: `To sever this control plane's access instantly: remove its key from ~/.ssh/authorized_keys on ${runner.host}. Your instance keeps running; only our reach ends.`,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle: upgrade/rollback, export-to-user, suspend/resume, verifiable
// delete, health.
// ---------------------------------------------------------------------------

export async function checkHealth({ rootDir, runner, record }) {
  const registry = openRegistry(rootDir);
  const result = await runner.exec('sh -s', { stdin: healthScript(record.name), timeoutMs: 20_000 }).catch((err) => ({ code: -1, stdout: '', stderr: err.message }));
  if (result.code === 0) {
    try {
      const status = JSON.parse(result.stdout);
      registry.save({
        ...record,
        status: 'running',
        app: { version: status.version, setupComplete: Boolean(status.setupComplete) },
        lastHealth: { at: new Date().toISOString(), ok: true, uptimeSeconds: status.uptimeSeconds ?? 0 },
      });
      return { ok: true, status };
    } catch {
      // fall through to state inspection
    }
  }
  const state = await runner.exec(`docker inspect -f '{{.State.Status}}' ${record.container}`).catch(() => null);
  const containerState = state?.code === 0 ? state.stdout.trim() : 'missing';
  registry.save({
    ...record,
    status: containerState === 'exited' || containerState === 'created' ? 'suspended' : 'unreachable',
    lastHealth: { at: new Date().toISOString(), ok: false, detail: firstLine(result.stderr) || `container ${containerState}` },
  });
  return { ok: false, containerState, detail: firstLine(result.stderr) };
}

export async function upgradeInstance({ rootDir, runner, record, image, archive, log = noop, sleep = defaultSleep, healthTimeoutMs = HEALTH_TIMEOUT_MS }) {
  const registry = openRegistry(rootDir);
  const name = record.name;
  const container = record.container;
  const prev = `${container}-prev`;

  const leftover = await runner.exec(`docker inspect --type container ${prev} >/dev/null 2>&1 && echo present || echo absent`);
  if (leftover.stdout.trim() !== 'absent') {
    throw new ByocError(`A previous upgrade left ${prev} behind. Inspect it (docker logs ${prev}), then remove it (docker rm -f ${prev}) and retry.`);
  }

  const resolved = await resolveImage(runner, { image, archive: archive ?? sourceArchive(), log });
  if (resolved.ref === record.image?.ref && resolved.commit && resolved.commit === record.image?.commit) {
    log(`  note: same source commit as the running instance (${resolved.commit.slice(0, 12)}).`);
  }

  log(`• Swapping ${container} to ${resolved.ref} (previous kept for rollback)…`);
  const swap = await runner.exec(`docker stop ${container} >/dev/null && docker rename ${container} ${prev}`);
  if (swap.code !== 0) throw new ByocError(`Could not stop the running instance: ${lastLine(swap.stderr)}`);

  const bind = record.bind?.address === '0.0.0.0' ? 'lan' : 'loopback';
  const run = await runner.exec(dockerRunCommand({ name, bind, port: record.bind.port, imageRef: resolved.ref }));
  let failure = run.code !== 0 ? `docker run failed: ${lastLine(run.stderr) || lastLine(run.stdout)}` : null;

  let status = null;
  if (!failure) {
    try {
      status = await pollHealth(runner, name, { timeoutMs: healthTimeoutMs, sleep, log });
    } catch (err) {
      failure = err.message;
    }
  }

  if (failure) {
    log('• Upgrade failed — rolling back to the previous container…');
    const logs = await containerLogs(runner, name);
    await runner.exec(`docker rm -f ${container} >/dev/null 2>&1 || true`).catch(() => {});
    const restore = await runner.exec(`docker rename ${prev} ${container} && docker start ${container} >/dev/null`);
    if (restore.code !== 0) {
      throw new ByocError(`Upgrade failed AND rollback failed: ${lastLine(restore.stderr)}. The previous container is named ${prev} on the host; rename and start it manually.`);
    }
    const back = await pollHealth(runner, name, { timeoutMs: Math.min(healthTimeoutMs, 60_000), sleep, log }).catch(() => null);
    throw new ByocError(`Upgrade failed (${failure}); rolled back to the previous version${back ? ` — v${back.version} is healthy again` : ', but re-verify it: sovereign byoc status ' + name}.${logs ? `\nNew container logs:\n${logs}` : ''}`);
  }

  await runner.exec(`docker rm ${prev} >/dev/null 2>&1 || true`).catch(() => {});
  const saved = registry.save({
    ...record,
    image: { mode: image.mode, ref: resolved.ref, commit: resolved.commit },
    app: { version: status.version, setupComplete: Boolean(status.setupComplete) },
    status: 'running',
    lastHealth: { at: new Date().toISOString(), ok: true, uptimeSeconds: status.uptimeSeconds ?? 0 },
  });
  log(`  upgraded: SovereignAI v${status.version}`);
  return { record: saved, status };
}

/** Stream a full export to the OWNER's machine — the exit path is a product
 * feature, and it never routes through anything we keep. */
export async function exportInstance({ runner, record, outFile, log = noop }) {
  const container = record.container;
  const script = `set -eu
docker exec ${container} node --no-warnings bin/sovereign.js export /tmp/sovereign-export.json >/dev/null
docker exec ${container} cat /tmp/sovereign-export.json
docker exec ${container} rm -f /tmp/sovereign-export.json
`;
  log(`• Exporting from ${container} to ${outFile}…`);
  const result = await runner.exec('sh -s', { stdin: script, timeoutMs: 10 * 60_000, stdoutFile: outFile });
  if (result.code !== 0) {
    fs.rmSync(outFile, { force: true });
    throw new ByocError(`Export failed: ${firstLine(result.stderr)}`);
  }
  const head = Buffer.alloc(1);
  const fd = fs.openSync(outFile, 'r');
  try {
    fs.readSync(fd, head, 0, 1, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (head.toString() !== '{') {
    fs.rmSync(outFile, { force: true });
    throw new ByocError('Export did not produce JSON; nothing was saved.');
  }
  try {
    fs.chmodSync(outFile, 0o600);
  } catch (err) {
    if (err.code !== 'EPERM' && err.code !== 'ENOSYS') throw err;
  }
  return { outFile, bytes: fs.statSync(outFile).size };
}

export async function suspendInstance({ rootDir, runner, record }) {
  const result = await runner.exec(`docker stop ${record.container} >/dev/null && echo stopped`);
  if (result.code !== 0) throw new ByocError(`Could not stop ${record.container}: ${lastLine(result.stderr)}`);
  return openRegistry(rootDir).save({ ...record, status: 'suspended' });
}

export async function resumeInstance({ rootDir, runner, record, sleep = defaultSleep, log = noop }) {
  const result = await runner.exec(`docker start ${record.container} >/dev/null && echo started`);
  if (result.code !== 0) throw new ByocError(`Could not start ${record.container}: ${lastLine(result.stderr)}`);
  const status = await pollHealth(runner, record.name, { timeoutMs: 60_000, sleep, log });
  openRegistry(rootDir).save({
    ...record,
    status: 'running',
    app: { version: status.version, setupComplete: Boolean(status.setupComplete) },
    lastHealth: { at: new Date().toISOString(), ok: true, uptimeSeconds: status.uptimeSeconds ?? 0 },
  });
  return status;
}

export function destroyScript(name, { purgeData = false } = {}) {
  const container = containerName(name);
  const volume = volumeName(name);
  const dir = remoteDir(name);
  const lines = [
    'set -u',
    `docker rm -f ${container} >/dev/null 2>&1 || true`,
    `docker rm -f ${container}-prev >/dev/null 2>&1 || true`,
  ];
  if (purgeData) {
    lines.push(`docker volume rm ${volume} >/dev/null 2>&1 || true`);
    lines.push(`rm -rf "$HOME/${dir}"`);
  }
  lines.push(
    `docker inspect --type container ${container} >/dev/null 2>&1 && printf 'container=present\\n' || printf 'container=absent\\n'`,
    `docker volume inspect ${volume} >/dev/null 2>&1 && printf 'volume=present\\n' || printf 'volume=absent\\n'`,
    `[ -d "$HOME/${dir}" ] && printf 'dir=present\\n' || printf 'dir=absent\\n'`
  );
  return `${lines.join('\n')}\n`;
}

/** Delete is verifiable: we re-inspect the host and show the user what is
 * (and is not) left. Data purge only happens when explicitly requested. */
export async function destroyInstance({ rootDir, runner, record, purgeData = false, log = noop }) {
  log(`• Removing ${record.container} on ${runner.describe()}${purgeData ? ' AND its data volume' : ' (data volume kept)'}…`);
  const result = await runner.exec('sh -s', { stdin: destroyScript(record.name, { purgeData }) });
  const verification = parsePreflight(result.stdout);
  openRegistry(rootDir).remove(record.name);
  return {
    verification,
    clean:
      verification.container === 'absent' &&
      (!purgeData || (verification.volume === 'absent' && verification.dir === 'absent')),
  };
}

// ---------------------------------------------------------------------------

function packageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function firstLine(text) {
  return String(text ?? '').split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}

function lastLine(text) {
  const lines = String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function noop() {}
