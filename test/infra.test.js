import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(repo, file), 'utf8');

test('installed launchers choose a stable home but preserve an explicit override', () => {
  const windows = read('scripts/install.ps1');
  assert.match(windows, /if not defined SOVEREIGN_HOME set "SOVEREIGN_HOME=\$dest"/);
  assert.match(windows, /Refreshing existing archive install/);
  assert.match(windows, /Copy-Item -Destination \$dest -Recurse -Force/);

  const unix = read('scripts/install.sh');
  assert.match(unix, /if \[ -z "\\\$\{SOVEREIGN_HOME:-\}" \]; then/);
  assert.match(unix, /export SOVEREIGN_HOME="\$DEST"/);
  assert.match(unix, /elif \[ -d "\$DEST" \]; then[\s\S]*install_archive/);
});

test('CI and release workflows use the bounded package suite and explicit artifacts', () => {
  assert.match(read('.github/workflows/ci.yml'), /run: npm test/);
  const release = read('.github/workflows/release.yml');
  assert.match(release, /run: npm test/);
  assert.match(release, /--out "\$RUNNER_TEMP\/sovereignai-/);
  assert.doesNotMatch(release, /integrations\/browser\/sovereignai-browser-\*\.zip/);
});

test('release integration source versions align with the SovereignAI release', () => {
  // The version the binaries, the CLI, the MCP server, and /api/status report
  // lives in src/config.js; the first v0.6.0 build shipped 0.5.0 binaries because
  // it had drifted from package.json. Pinned together here.
  assert.equal(JSON.parse(read('package.json')).version, '0.6.0');
  assert.match(read('src/config.js'), /export const VERSION = '0.6.0';/);
  assert.equal(JSON.parse(read('integrations/browser/manifest.json')).version, '0.6.0');
  assert.equal(JSON.parse(read('integrations/vscode/package.json')).version, '0.6.0');
  assert.match(read('integrations/jetbrains/build.gradle.kts'), /version = "0.6.0"/);
  assert.match(read('integrations/chatgpt/openapi.yaml'), /version: 0.6.0/);
});

test('Docker uses one durable state root and retains the prior database volume', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /SOVEREIGN_HOME=\/state/);
  assert.match(dockerfile, /VOLUME \/state/);
  assert.match(dockerfile, /Authorization: Bearer \$\{SOVEREIGN_TOKEN\}/);

  const compose = read('docker-compose.yml');
  assert.match(compose, /SOVEREIGN_HOME: \/state/);
  assert.match(compose, /sovereign-state:\/state/);
  assert.match(compose, /sovereign-data:\/state\/data/);
  assert.match(compose, /OLLAMA_BASE_URL: \$\{OLLAMA_BASE_URL:-http:\/\/ollama:11434\}/);
  assert.match(compose, /OLLAMA_BASE_URL=http:\/\/host\.docker\.internal:11434/);

  const dockerignore = read('.dockerignore');
  for (const secretPattern of ['.env', '.env.*', '*.pem', '*.key', 'sovereign.config.*.json']) {
    assert.ok(dockerignore.split(/\r?\n/).includes(secretPattern), `Docker build context must ignore ${secretPattern}`);
  }
});

const dockerCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
test('Compose profile resolves Ollama service and host override contracts', { skip: dockerCompose.status !== 0 }, () => {
  const baseEnv = { ...process.env, SOVEREIGN_TOKEN: 'compose-test-token' };
  delete baseEnv.OLLAMA_BASE_URL;
  const profiled = spawnSync('docker', ['compose', '--profile', 'ollama', 'config'], {
    cwd: repo,
    env: baseEnv,
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(profiled.status, 0, profiled.stderr);
  assert.match(profiled.stdout, /OLLAMA_BASE_URL: http:\/\/ollama:11434/);
  assert.match(profiled.stdout, /source: sovereign-state[\s\S]*target: \/state/);
  assert.match(profiled.stdout, /source: sovereign-data[\s\S]*target: \/state\/data/);

  const host = spawnSync('docker', ['compose', 'config'], {
    cwd: repo,
    env: { ...baseEnv, OLLAMA_BASE_URL: 'http://host.docker.internal:11434' },
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(host.status, 0, host.stderr);
  assert.match(host.stdout, /OLLAMA_BASE_URL: http:\/\/host\.docker\.internal:11434/);
});
