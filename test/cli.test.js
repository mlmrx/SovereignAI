import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'bin', 'sovereign.js');

function makeTemp(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sovereign-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runCli(args, { home, cwd = repo, env = {} } = {}) {
  const childEnv = { ...process.env, ...env };
  if (home === null) delete childEnv.SOVEREIGN_HOME;
  else if (home) childEnv.SOVEREIGN_HOME = home;
  return spawnSync(process.execPath, ['--no-warnings', cli, ...args], {
    cwd,
    env: childEnv,
    encoding: 'utf8',
    timeout: 20_000,
  });
}

test('SOVEREIGN_HOME keeps one installed instance across working directories', (t) => {
  const sandbox = makeTemp(t, 'home');
  const home = path.join(sandbox, 'stable-state');
  const cwdA = path.join(sandbox, 'project-a');
  const cwdB = path.join(sandbox, 'project-b');
  fs.mkdirSync(cwdA);
  fs.mkdirSync(cwdB);

  const initialized = runCli(['init'], { home, cwd: cwdA });
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.ok(fs.existsSync(path.join(home, 'sovereign.config.json')));
  assert.equal(fs.existsSync(path.join(cwdA, 'sovereign.config.json')), false);
  assert.match(initialized.stdout, new RegExp(escapeRegExp(home), 'i'));

  const exportFile = path.join(sandbox, 'backup.json');
  const exported = runCli(['export', exportFile], { home, cwd: cwdB });
  assert.equal(exported.status, 0, exported.stderr);
  assert.ok(fs.existsSync(exportFile));
  if (process.platform !== 'win32') assert.equal(fs.statSync(exportFile).mode & 0o777, 0o600);
  assert.ok(fs.existsSync(path.join(home, 'data', 'sovereign.db')));
  assert.equal(fs.existsSync(path.join(cwdB, 'data')), false);
  assert.equal(JSON.parse(fs.readFileSync(exportFile, 'utf8')).data.personas.length, 3);

  const sourceProject = path.join(sandbox, 'source-project');
  fs.mkdirSync(sourceProject);
  const projectLocal = runCli(['init'], { home: null, cwd: sourceProject });
  assert.equal(projectLocal.status, 0, projectLocal.stderr);
  assert.ok(fs.existsSync(path.join(sourceProject, 'sovereign.config.json')), 'direct source use should remain project-local');
});

test('CLI rejects unsafe start flags and unknown commands before starting', (t) => {
  const home = makeTemp(t, 'flags');
  const cases = [
    [['start', '--port', '0'], /Invalid port/],
    [['start', '--port=65536'], /Invalid port/],
    [['start', '--port', '1.5'], /Invalid port/],
    [['start', '--port'], /requires a value/],
    [['start', '--host', 'http:\/\/localhost'], /Invalid host/],
    [['start', '--host'], /requires a value/],
    [['start', '--lan', '--host', '127.0.0.1'], /cannot be used together/],
    [['start', '--wat'], /Unknown start option/],
    [['start', '--port', '4321', '--port', '4322'], /only be provided once/],
    [['definitely-not-a-command'], /Unknown command/],
  ];

  for (const [args, error] of cases) {
    const result = runCli(args, { home });
    assert.equal(result.status, 1, `${args.join(' ')} unexpectedly succeeded`);
    assert.match(result.stderr, error, `${args.join(' ')}: ${result.stderr}`);
  }
  assert.equal(fs.existsSync(path.join(home, 'data')), false, 'validation should not create state');

  const help = runCli(['start', '--help'], { home });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--port N/);
});

test('doctor reports local readiness and never prints configured secrets', (t) => {
  const sandbox = makeTemp(t, 'doctor');
  const home = path.join(sandbox, 'state');
  fs.mkdirSync(home);
  const apiKey = 'sk-ant-do-not-print-123456789';
  const authToken = 'super-secret-bearer-token';
  fs.writeFileSync(
    path.join(home, 'sovereign.config.json'),
    JSON.stringify({
      name: 'Doctor Test',
      setupComplete: true,
      authToken,
      providers: {
        ollama: { enabled: true, baseUrl: 'http://localhost:11434/private' },
        openai: { enabled: false, baseUrl: 'https://api.openai.com', apiKey },
        anthropic: { enabled: false, apiKey, baseUrl: 'https://api.anthropic.com' },
      },
      defaults: { provider: 'ollama', model: 'llama3.1:latest' },
      embeddings: { provider: 'ollama', model: '' },
    })
  );

  const exportFile = path.join(sandbox, 'seed.json');
  const seeded = runCli(['export', exportFile], { home });
  assert.equal(seeded.status, 0, seeded.stderr);

  const result = runCli(['doctor', '--no-network'], { home });
  assert.equal(result.status, 0, result.stderr);
  const output = result.stdout + result.stderr;
  assert.match(output, /SovereignAI doctor/);
  assert.match(output, /Database — healthy/);
  assert.match(output, /personas=3/);
  assert.match(output, /live check skipped/);
  assert.match(output, /secret not shown/);
  assert.doesNotMatch(output, new RegExp(escapeRegExp(apiKey)));
  assert.doesNotMatch(output, new RegExp(escapeRegExp(authToken)));
  assert.doesNotMatch(output, /\/private/);
});

test('doctor diagnoses invalid config without echoing its contents', (t) => {
  const home = makeTemp(t, 'bad-config');
  const secret = 'never-echo-this-secret';
  fs.writeFileSync(path.join(home, 'sovereign.config.json'), `{"apiKey":"${secret}",`);

  const result = runCli(['doctor', '--no-network'], { home });
  assert.equal(result.status, 1);
  const output = result.stdout + result.stderr;
  assert.match(output, /Config — cannot be parsed/);
  assert.match(output, /intentionally did not print its contents/);
  assert.doesNotMatch(output, new RegExp(escapeRegExp(secret)));
});

test('secured start prints an authenticated browser URL', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-secured-start-'));
  const token = 'token-with+/characters';
  fs.writeFileSync(
    path.join(home, 'sovereign.config.json'),
    JSON.stringify({
      authToken: token,
      setupComplete: true,
      providers: { ollama: { enabled: false } },
      embeddings: { model: '' },
    })
  );
  const port = await availablePort();
  const child = spawn(process.execPath, ['--no-warnings', cli, 'start', '--port', String(port)], {
    cwd: repo,
    env: { ...process.env, SOVEREIGN_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    await stopChild(child);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  await waitFor(() => stdout.includes('Your models. Your memory.'), 10_000, () => stderr);

  assert.match(stdout, new RegExp(`http://127\\.0\\.0\\.1:${port}/#token=${escapeRegExp(encodeURIComponent(token))}`));
  const unauthorized = await fetch(`http://127.0.0.1:${port}/api/status`);
  assert.equal(unauthorized.status, 401);
  const authorized = await fetch(`http://127.0.0.1:${port}/api/status`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(authorized.status, 200);
  await stopChild(child);
});

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(predicate, timeoutMs, diagnostic) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for CLI output. ${diagnostic()}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
