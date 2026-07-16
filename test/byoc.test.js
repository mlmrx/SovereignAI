import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { shq, parseSshTarget, createSshRunner, SshError } from '../src/byoc/ssh.js';
import { assertInstanceName, knownHostsPath, openRegistry } from '../src/byoc/registry.js';
import {
  ByocError,
  deploy,
  deployPlan,
  destroyInstance,
  destroyScript,
  dockerRunCommand,
  ensureEnvScript,
  evaluatePreflight,
  exportInstance,
  healthScript,
  parsePreflight,
  preflightScript,
  upgradeInstance,
} from '../src/byoc/connector.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'bin', 'sovereign.js');

function makeTemp(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sovereign-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runCli(args, { home, cwd = repo } = {}) {
  return spawnSync(process.execPath, ['--no-warnings', cli, ...args], {
    cwd,
    env: { ...process.env, SOVEREIGN_HOME: home },
    encoding: 'utf8',
    timeout: 20_000,
  });
}

// A scripted "user-owned Linux box": handlers match a command (or the script
// piped to its stdin) and return what the host would say. Every call is
// recorded so tests can assert the exact provisioning sequence.
function fakeRunner(handlers) {
  const calls = [];
  return {
    calls,
    describe: () => 'deploy@fake-host',
    target: 'deploy@fake-host',
    host: 'fake-host',
    sshPort: 22,
    keyPath: null,
    async exec(command, opts = {}) {
      const stdin = opts.stdin ? String(opts.stdin) : '';
      calls.push({ command, stdin });
      for (const handler of handlers) {
        if (handler.match(command, stdin)) {
          const raw = typeof handler.result === 'function' ? handler.result(command, opts) : handler.result;
          const result = { code: 0, stdout: '', stderr: '', ...raw };
          if (opts.stdoutFile && result.code === 0) fs.writeFileSync(opts.stdoutFile, result.stdout);
          return result;
        }
      }
      throw new Error(`fake host has no handler for: ${command} :: ${stdin.slice(0, 60)}`);
    },
  };
}

const HEALTHY_STATUS = JSON.stringify({ name: 'Test', version: '9.9.9', uptimeSeconds: 3, counts: {}, setupComplete: false });
const FAKE_TOKEN = 'f'.repeat(64);
const GOOD_PREFLIGHT = [
  'os=Linux', 'arch=x86_64', 'uid=1000', 'user=deploy', 'docker_cli=yes', 'docker_server=27.1.1',
  `disk_avail_kb=${20 * 1024 * 1024}`, 'outbound=yes', 'port_in_use=no',
].join('\n');

function standardHandlers({ healthResults = [{ code: 0, stdout: HEALTHY_STATUS }] } = {}) {
  let healthCall = 0;
  return [
    { match: (c, s) => s.includes('docker_cli'), result: { stdout: GOOD_PREFLIGHT } },
    { match: (c) => c.includes('docker inspect --type container') && c.includes('echo absent'), result: { stdout: 'absent\n' } },
    { match: (c, s) => s.includes('SOVEREIGN_TOKEN=%s'), result: { stdout: 'env=ready\n' } },
    { match: (c) => c.startsWith('docker build '), result: { stdout: 'built\n' } },
    { match: (c) => c.startsWith('docker pull '), result: { stdout: 'pulled\n' } },
    { match: (c) => c.startsWith('docker run -d '), result: { stdout: 'abc123\n' } },
    { match: (c, s) => s.includes('/api/status'), result: () => healthResults[Math.min(healthCall++, healthResults.length - 1)] },
    { match: (c, s) => s.includes('printf %s "$SOVEREIGN_TOKEN"'), result: { stdout: FAKE_TOKEN } },
    { match: (c) => c.includes('docker logs'), result: { stdout: 'boot log line\n' } },
    { match: (c) => c.includes('docker rm'), result: { stdout: '' } },
    { match: (c) => c.includes('docker stop') && c.includes('docker rename'), result: { stdout: '' } },
    { match: (c) => c.includes('docker rename') && c.includes('docker start'), result: { stdout: '' } },
  ];
}

const fakeArchive = async () => ({ tar: Buffer.from('fake-tar'), commit: 'c'.repeat(40), ref: 'sovereignai:test-build' });

// ---------------------------------------------------------------------------
// units
// ---------------------------------------------------------------------------

test('shq survives quotes and shell metacharacters', () => {
  assert.equal(shq('plain'), `'plain'`);
  assert.equal(shq(`it's`), `'it'\\''s'`);
  assert.equal(shq('a;rm -rf $HOME `x`'), `'a;rm -rf $HOME \`x\`'`);
});

test('parseSshTarget accepts user@host and rejects junk', () => {
  assert.deepEqual(parseSshTarget('deploy@203.0.113.7').target, 'deploy@203.0.113.7');
  assert.equal(parseSshTarget('a_user@my-box.example.com').host, 'my-box.example.com');
  for (const bad of ['', 'nohost@', '@nouser', 'plainhost', 'user@ho st', 'user@-bad', 'a b@host']) {
    assert.throws(() => parseSshTarget(bad), SshError, bad);
  }
});

test('instance names are constrained to safe container/volume material', () => {
  assert.equal(assertInstanceName('main'), 'main');
  assert.equal(assertInstanceName('team-a2'), 'team-a2');
  for (const bad of ['Main', '2fast', 'has space', 'x'.repeat(32), '../evil', 'a_b', '']) {
    assert.throws(() => assertInstanceName(bad), /Invalid instance name/, bad);
  }
});

test('createSshRunner demands a known_hosts file for pinning', () => {
  assert.throws(() => createSshRunner({ target: 'a@b' }), /knownHostsFile/);
});

test('preflight report parsing and verdicts', () => {
  assert.ok(preflightScript({ registryHost: 'ghcr.io', port: 5000 }).includes('https://ghcr.io/v2/'));

  const good = parsePreflight(GOOD_PREFLIGHT);
  assert.equal(good.docker_server, '27.1.1');
  assert.deepEqual(evaluatePreflight(good).failures, []);

  const noDocker = evaluatePreflight(parsePreflight('os=Linux\narch=x86_64\nuid=1000\ndocker_cli=no\ndisk_avail_kb=99999999\noutbound=yes\nport_in_use=no'));
  assert.equal(noDocker.ok, false);
  assert.match(noDocker.failures.join(' '), /get\.docker\.com/);
  assert.match(noDocker.failures.join(' '), /never do it for you/i);

  const noPerm = evaluatePreflight(parsePreflight('os=Linux\nuser=deploy\ndocker_cli=yes\ndocker_server=\ndocker_error=permission denied while trying to connect\ndisk_avail_kb=99999999\noutbound=yes\nport_in_use=no'));
  assert.match(noPerm.failures.join(' '), /usermod -aG docker deploy/);

  const notLinux = evaluatePreflight(parsePreflight('os=Darwin\ndocker_cli=yes\ndocker_server=27.0.0\ndisk_avail_kb=99999999\noutbound=yes\nport_in_use=no'));
  assert.match(notLinux.failures.join(' '), /Linux/);

  const tightDisk = evaluatePreflight(parsePreflight(`os=Linux\ndocker_cli=yes\ndocker_server=27.0.0\ndisk_avail_kb=${500 * 1024}\noutbound=yes\nport_in_use=no`));
  assert.match(tightDisk.failures.join(' '), /1 GiB/);

  const rootWarn = evaluatePreflight(parsePreflight(`os=Linux\nuid=0\ndocker_cli=yes\ndocker_server=27.0.0\ndisk_avail_kb=${20 * 1024 * 1024}\noutbound=yes\nport_in_use=no`));
  assert.equal(rootWarn.ok, true);
  assert.match(rootWarn.warnings.join(' '), /root/i);

  const portBusy = evaluatePreflight(parsePreflight(`os=Linux\ndocker_cli=yes\ndocker_server=27.0.0\ndisk_avail_kb=${20 * 1024 * 1024}\noutbound=yes\nport_in_use=yes`), { port: 4321 });
  assert.match(portBusy.failures.join(' '), /4321/);

  const offlinePull = evaluatePreflight(parsePreflight(`os=Linux\ndocker_cli=yes\ndocker_server=27.0.0\ndisk_avail_kb=${20 * 1024 * 1024}\noutbound=no\nport_in_use=no`), { imageMode: 'pull' });
  assert.equal(offlinePull.ok, false);
  const offlineBuild = evaluatePreflight(parsePreflight(`os=Linux\ndocker_cli=yes\ndocker_server=27.0.0\ndisk_avail_kb=${20 * 1024 * 1024}\noutbound=no\nport_in_use=no`), { imageMode: 'source' });
  assert.equal(offlineBuild.ok, true);
  assert.match(offlineBuild.warnings.join(' '), /cached/);
});

test('ensureEnvScript generates the token host-side and validates extra env', () => {
  const script = ensureEnvScript('main', { OLLAMA_BASE_URL: 'http://10.0.0.5:11434' });
  assert.ok(script.includes('/dev/urandom'), 'token comes from the host, not from us');
  assert.ok(script.includes(`upsert 'OLLAMA_BASE_URL' 'http://10.0.0.5:11434'`));
  assert.ok(script.includes('umask 077'));
  assert.throws(() => ensureEnvScript('main', { 'bad-key': 'x' }), /UPPER_SNAKE_CASE/);
  assert.throws(() => ensureEnvScript('main', { GOOD_KEY: 'a\nb' }), /newlines/);
});

test('the container we run is the hardened one', () => {
  const loopback = dockerRunCommand({ name: 'main', bind: 'loopback', port: 4321, imageRef: 'sovereignai:x' });
  for (const flag of ['--read-only', '--tmpfs /tmp', '--security-opt no-new-privileges', '-p 127.0.0.1:4321:4321', '-v sovereign-main-state:/state', '--env-file', '--restart unless-stopped']) {
    assert.ok(loopback.includes(flag), `missing ${flag}`);
  }
  const lan = dockerRunCommand({ name: 'main', bind: 'lan', port: 8080, imageRef: 'sovereignai:x' });
  assert.ok(lan.includes('-p 0.0.0.0:8080:4321'));
  assert.ok(deployPlan({ name: 'main', target: 'a@b', port: 4321, bind: 'loopback', image: { mode: 'source' }, envKeys: ['OLLAMA_BASE_URL'] }).includes('OLLAMA_BASE_URL'));
});

test('health probe keeps the token on the host', () => {
  const script = healthScript('main');
  assert.ok(script.includes('. ./env'), 'token is sourced from the host env file');
  assert.ok(script.includes('docker exec sovereign-main wget'));
  assert.ok(script.includes('127.0.0.1:4321/api/status'));
});

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

test('registry stores metadata only and refuses secrets', (t) => {
  const home = makeTemp(t, 'byoc-reg');
  const registry = openRegistry(home);
  assert.deepEqual(registry.list(), []);
  registry.save({ name: 'main', ssh: { target: 'a@b', port: 22, keyPath: null }, status: 'running' });
  assert.equal(registry.get('main').ssh.target, 'a@b');
  assert.ok(registry.get('main').updatedAt);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(registry.path).mode & 0o777, 0o600);
  }
  assert.throws(() => registry.save({ name: 'main', token: 'secret' }), /Refusing to store secret/);
  assert.throws(() => registry.save({ name: 'main', privateKey: 'x' }), /Refusing to store secret/);
  assert.equal(registry.remove('main'), true);
  assert.equal(registry.get('main'), null);
});

// ---------------------------------------------------------------------------
// deploy orchestration against the scripted host
// ---------------------------------------------------------------------------

test('deploy provisions, verifies, registers, and hands off — token never stored', async (t) => {
  const home = makeTemp(t, 'byoc-deploy');
  const runner = fakeRunner(standardHandlers());
  const logs = [];

  const { record, handoff } = await deploy({
    rootDir: home, runner, name: 'main', port: 4321, bind: 'loopback',
    image: { mode: 'source' }, env: { OLLAMA_BASE_URL: 'http://10.0.0.5:11434' },
    archive: fakeArchive, fingerprint: async () => 'SHA256:fakefingerprint',
    log: (line) => logs.push(line), sleep: async () => {},
  });

  // Sequence: preflight → guard → env → build → run → health → token read.
  const kinds = runner.calls.map(({ command, stdin }) => {
    if (stdin.includes('docker_cli')) return 'preflight';
    if (command.includes('docker inspect --type container')) return 'guard';
    if (stdin.includes('SOVEREIGN_TOKEN=%s')) return 'env';
    if (command.startsWith('docker build')) return 'build';
    if (command.startsWith('docker run')) return 'run';
    if (stdin.includes('/api/status')) return 'health';
    if (stdin.includes('printf %s "$SOVEREIGN_TOKEN"')) return 'token';
    return 'other';
  });
  assert.deepEqual(kinds, ['preflight', 'guard', 'env', 'build', 'run', 'health', 'token']);

  const runCall = runner.calls.find(({ command }) => command.startsWith('docker run'));
  assert.ok(runCall.command.includes('--read-only'));
  assert.ok(runCall.command.includes('-p 127.0.0.1:4321:4321'));
  assert.ok(runCall.command.includes('sovereignai:test-build'));

  const buildCall = runner.calls.find(({ command }) => command.startsWith('docker build'));
  assert.equal(buildCall.stdin, 'fake-tar', 'the committed source context streams to the host');

  assert.equal(record.tokenSha256, crypto.createHash('sha256').update(FAKE_TOKEN).digest('hex'));
  assert.equal(record.hostKeyFingerprint, 'SHA256:fakefingerprint');
  assert.equal(record.image.commit, 'c'.repeat(40));
  assert.equal(record.app.version, '9.9.9');

  const registryText = fs.readFileSync(path.join(home, 'byoc', 'instances.json'), 'utf8');
  assert.ok(!registryText.includes(FAKE_TOKEN), 'plaintext token must never be stored in the registry');
  assert.ok(registryText.includes(record.tokenSha256));

  assert.ok(handoff.url.includes(`#token=${FAKE_TOKEN}`), 'the owner gets the authenticated URL once');
  assert.match(handoff.tunnel, /ssh -N -L 4321:127\.0\.0\.1:4321 deploy@fake-host/);
  assert.match(handoff.revoke, /authorized_keys/);
});

test('deploy stops at a failed preflight and touches nothing else', async (t) => {
  const home = makeTemp(t, 'byoc-nofly');
  const runner = fakeRunner([
    { match: (c, s) => s.includes('docker_cli'), result: { stdout: 'os=Linux\narch=x86_64\nuid=1000\ndocker_cli=no\ndisk_avail_kb=99999999\noutbound=yes\nport_in_use=no' } },
  ]);
  await assert.rejects(
    deploy({ rootDir: home, runner, name: 'main', archive: fakeArchive, sleep: async () => {} }),
    (err) => err instanceof ByocError && /nothing was deployed/i.test(err.message) && /Docker is not installed/.test(err.message)
  );
  assert.equal(runner.calls.length, 1, 'no provisioning after a failed preflight');
  assert.equal(openRegistry(home).get('main'), null);
});

test('deploy that never turns healthy removes the container and registers nothing', async (t) => {
  const home = makeTemp(t, 'byoc-sick');
  const runner = fakeRunner(standardHandlers({ healthResults: [{ code: 1, stderr: 'connection refused' }] }));
  await assert.rejects(
    deploy({ rootDir: home, runner, name: 'main', archive: fakeArchive, sleep: async () => {}, healthTimeoutMs: 1 }),
    /did not become healthy[\s\S]*half-deployed/
  );
  assert.ok(
    runner.calls.some(({ command }) => command.includes('docker rm -f sovereign-main')),
    'the unhealthy container is removed'
  );
  assert.equal(openRegistry(home).get('main'), null);
});

test('deploy refuses a name that already exists in the registry', async (t) => {
  const home = makeTemp(t, 'byoc-dupe');
  openRegistry(home).save({ name: 'main', ssh: { target: 'a@b' } });
  await assert.rejects(
    deploy({ rootDir: home, runner: fakeRunner([]), name: 'main', archive: fakeArchive }),
    /already exists in the registry/
  );
});

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

function existingRecord(home) {
  return openRegistry(home).save({
    name: 'main',
    createdAt: new Date().toISOString(),
    ssh: { target: 'deploy@fake-host', port: 22, keyPath: null },
    remoteDir: '.sovereignai/main',
    container: 'sovereign-main',
    volume: 'sovereign-main-state',
    image: { mode: 'source', ref: 'sovereignai:old', commit: 'o'.repeat(40) },
    bind: { address: '127.0.0.1', port: 4321 },
    tokenSha256: 'deadbeef',
    app: { version: '0.3.0', setupComplete: true },
    status: 'running',
  });
}

test('upgrade swaps the container and keeps the volume', async (t) => {
  const home = makeTemp(t, 'byoc-up');
  const record = existingRecord(home);
  const runner = fakeRunner([
    { match: (c) => c.includes('sovereign-main-prev >/dev/null 2>&1 && echo present'), result: { stdout: 'absent\n' } },
    ...standardHandlers(),
  ]);
  const { record: updated } = await upgradeInstance({
    rootDir: home, runner, record, image: { mode: 'source' }, archive: fakeArchive, sleep: async () => {},
  });
  assert.equal(updated.image.ref, 'sovereignai:test-build');
  assert.equal(updated.app.version, '9.9.9');

  const sequence = runner.calls.map(({ command }) => command);
  const stopIdx = sequence.findIndex((c) => c.includes('docker stop sovereign-main') && c.includes('docker rename'));
  const runIdx = sequence.findIndex((c) => c.startsWith('docker run'));
  const cleanupIdx = sequence.findIndex((c) => c.includes('docker rm sovereign-main-prev'));
  assert.ok(stopIdx !== -1 && runIdx > stopIdx && cleanupIdx > runIdx, `old stops before new runs before prev cleanup: ${sequence.join(' | ')}`);
  const newRun = sequence[runIdx];
  assert.ok(newRun.includes('-v sovereign-main-state:/state'), 'the data volume carries over');
});

test('failed upgrade rolls back to the previous container', async (t) => {
  const home = makeTemp(t, 'byoc-rollback');
  const record = existingRecord(home);
  // The new container never becomes healthy; only once the previous container
  // has actually been restored does the health probe succeed again.
  let restored = false;
  const runner = fakeRunner([
    { match: (c) => c.includes('sovereign-main-prev >/dev/null 2>&1 && echo present'), result: { stdout: 'absent\n' } },
    {
      match: (c) => c.includes('docker rename sovereign-main-prev sovereign-main') && c.includes('docker start'),
      result: () => {
        restored = true;
        return { stdout: '' };
      },
    },
    {
      match: (c, s) => s.includes('/api/status'),
      result: () => (restored ? { code: 0, stdout: HEALTHY_STATUS } : { code: 1, stderr: 'boom' }),
    },
    ...standardHandlers(),
  ]);
  await assert.rejects(
    upgradeInstance({ rootDir: home, runner, record, image: { mode: 'source' }, archive: fakeArchive, sleep: async () => {}, healthTimeoutMs: 1 }),
    /rolled back to the previous version.*healthy again/s
  );
  const sequence = runner.calls.map(({ command }) => command);
  const rmNew = sequence.findIndex((c) => c.includes('docker rm -f sovereign-main '));
  const restore = sequence.findIndex((c) => c.includes('docker rename sovereign-main-prev sovereign-main') && c.includes('docker start'));
  assert.ok(rmNew !== -1 && restore > rmNew, `failed container removed, then previous restored: ${sequence.join(' | ')}`);
  assert.equal(openRegistry(home).get('main').image.ref, 'sovereignai:old', 'registry still points at the running (old) version');
});

test('a leftover -prev container blocks upgrade loudly', async (t) => {
  const home = makeTemp(t, 'byoc-leftover');
  const record = existingRecord(home);
  const runner = fakeRunner([
    { match: (c) => c.includes('sovereign-main-prev >/dev/null 2>&1 && echo present'), result: { stdout: 'present\n' } },
  ]);
  await assert.rejects(
    upgradeInstance({ rootDir: home, runner, record, image: { mode: 'source' }, archive: fakeArchive }),
    /previous upgrade left sovereign-main-prev/
  );
});

test('export streams the instance data to the owner and validates it', async (t) => {
  const home = makeTemp(t, 'byoc-export');
  const record = existingRecord(home);
  const payload = JSON.stringify({ sovereignai: '9.9.9', data: { personas: [] } });
  const runner = fakeRunner([
    { match: (c, s) => s.includes('sovereign-export.json'), result: { stdout: payload } },
  ]);
  const outFile = path.join(home, 'out.json');
  const { bytes } = await exportInstance({ runner, record, outFile });
  assert.equal(bytes, Buffer.byteLength(payload));
  assert.equal(JSON.parse(fs.readFileSync(outFile, 'utf8')).sovereignai, '9.9.9');
  if (process.platform !== 'win32') assert.equal(fs.statSync(outFile).mode & 0o777, 0o600);

  const junkRunner = fakeRunner([
    { match: (c, s) => s.includes('sovereign-export.json'), result: { stdout: 'error: not json' } },
  ]);
  const junkFile = path.join(home, 'junk.json');
  await assert.rejects(exportInstance({ runner: junkRunner, record, outFile: junkFile }), /did not produce JSON/);
  assert.equal(fs.existsSync(junkFile), false, 'a bad export leaves no file behind');
});

test('destroy is verifiable; data purge only on request', async (t) => {
  const withPurge = destroyScript('main', { purgeData: true });
  assert.ok(withPurge.includes('docker volume rm sovereign-main-state'));
  assert.ok(withPurge.includes('rm -rf "$HOME/.sovereignai/main"'));
  const withoutPurge = destroyScript('main');
  assert.ok(!withoutPurge.includes('docker volume rm'), 'no purge without --purge-data');
  assert.ok(!withoutPurge.includes('rm -rf'));
  assert.ok(withoutPurge.includes('volume inspect'), 'verification always runs');

  const home = makeTemp(t, 'byoc-destroy');
  const record = existingRecord(home);
  const runner = fakeRunner([
    { match: (c, s) => s.includes('container=present'), result: { stdout: 'container=absent\nvolume=present\ndir=present\n' } },
  ]);
  const { verification, clean } = await destroyInstance({ rootDir: home, runner, record, purgeData: false });
  assert.equal(clean, true, 'without purge, a surviving volume is the intended state');
  assert.equal(verification.volume, 'present');
  assert.equal(openRegistry(home).get('main'), null);

  const record2 = existingRecord(home);
  const dirtyRunner = fakeRunner([
    { match: (c, s) => s.includes('container=present'), result: { stdout: 'container=absent\nvolume=present\ndir=absent\n' } },
  ]);
  const purged = await destroyInstance({ rootDir: home, runner: dirtyRunner, record: record2, purgeData: true });
  assert.equal(purged.clean, false, 'a volume that survives a purge is reported, not papered over');
});

// ---------------------------------------------------------------------------
// CLI surface
// ---------------------------------------------------------------------------

test('byoc CLI: help, guardrails, and plan-without-apply', (t) => {
  const home = makeTemp(t, 'byoc-cli');

  const help = runCli(['byoc', 'help'], { home });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /deploy SovereignAI to a Docker host you own/);
  assert.match(help.stdout, /--purge-data/);

  const noHost = runCli(['byoc', 'deploy'], { home });
  assert.equal(noHost.status, 1);
  assert.match(noHost.stderr, /requires --host/);

  const badTarget = runCli(['byoc', 'deploy', '--host', 'nodomain'], { home });
  assert.equal(badTarget.status, 1);
  assert.match(badTarget.stderr, /expected user@host/);

  const badFlag = runCli(['byoc', 'deploy', '--host', 'a@b', '--frobnicate'], { home });
  assert.equal(badFlag.status, 1);
  assert.match(badFlag.stderr, /Unknown option --frobnicate/);

  const emptyList = runCli(['byoc', 'list'], { home });
  assert.equal(emptyList.status, 0);
  assert.match(emptyList.stdout, /No BYOC instances registered/);

  const missing = runCli(['byoc', 'status', 'ghost'], { home });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No instance named "ghost"/);

  const unknown = runCli(['byoc', 'frob'], { home });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown byoc action/);

  // Plan without --yes on a non-TTY: show everything, deploy nothing, no ssh.
  const plan = runCli(['byoc', 'deploy', '--host', 'deploy@203.0.113.7', '--name', 'planned', '--env', 'OLLAMA_BASE_URL=http://10.0.0.5:11434'], { home });
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /Deployment plan/);
  assert.match(plan.stdout, /--read-only/);
  assert.match(plan.stdout, /OLLAMA_BASE_URL/);
  assert.match(plan.stdout, /Nothing was deployed/);
  assert.equal(fs.existsSync(path.join(home, 'byoc', 'instances.json')), false);

  assert.equal(runCli(['byoc', 'export'], { home }).status, 1, 'export needs a name');
});

test('the main CLI help advertises byoc', (t) => {
  const home = makeTemp(t, 'byoc-help');
  const help = runCli(['help'], { home });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /byoc <action>/);
});
