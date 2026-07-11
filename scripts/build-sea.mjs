// Builds a self-contained SovereignAI executable with Node's single
// executable application (SEA) support: the module graph and web UI are
// embedded as SEA assets and booted by scripts/sea/boot.cjs.
//
//   node scripts/build-sea.mjs [--out-dir dist] [--skip-smoke]
//
// The runtime stays zero-dependency; `postject` (the injector Node's SEA
// documentation prescribes) is fetched with npx at build time only.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { collectSeaAssets } from './sea/manifest.mjs';
import { VERSION } from '../src/config.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POSTJECT = 'postject@1.0.0-alpha.6';
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const args = process.argv.slice(2);
const outDir = path.resolve(repo, argValue(args, '--out-dir') ?? 'dist');
const skipSmoke = args.includes('--skip-smoke');

assertNodeSupportsSyncModuleHooks();
fs.mkdirSync(outDir, { recursive: true });

const platform = { win32: 'win', darwin: 'macos', linux: 'linux' }[process.platform] ?? process.platform;
const binaryName = `sovereign-v${VERSION}-${platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`;
const binaryPath = path.join(outDir, binaryName);
const blobPath = path.join(outDir, 'sovereign-sea.blob');
const configFile = path.join(outDir, 'sea-config.json');

const { assets } = collectSeaAssets(repo);
console.log(`Embedding ${Object.keys(assets).length} assets (module graph + web UI)`);
fs.writeFileSync(
  configFile,
  JSON.stringify(
    {
      main: path.join(repo, 'scripts', 'sea', 'boot.cjs'),
      output: blobPath,
      disableExperimentalSEAWarning: true,
      assets,
    },
    null,
    2
  )
);

run(process.execPath, ['--no-warnings', '--experimental-sea-config', configFile], 'generate SEA blob');

fs.copyFileSync(process.execPath, binaryPath);
fs.chmodSync(binaryPath, 0o755);
if (process.platform === 'darwin') run('codesign', ['--remove-signature', binaryPath], 'remove macOS signature');

const postjectArgs = ['--yes', POSTJECT, binaryPath, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', SEA_FUSE];
if (process.platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
run('npx', postjectArgs, 'inject SEA blob (postject, build-time only)', { shell: process.platform === 'win32' });

if (process.platform === 'darwin') run('codesign', ['--sign', '-', binaryPath], 'ad-hoc sign macOS binary');
fs.rmSync(blobPath, { force: true });

if (skipSmoke) {
  console.log(`Built ${binaryPath} (smoke test skipped)`);
} else {
  await smokeTest(binaryPath);
  console.log(`Built and smoke-tested ${binaryPath}`);
}

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function assertNodeSupportsSyncModuleHooks() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const ok = major >= 24 || (major === 22 && minor >= 15) || (major === 23 && minor >= 5);
  if (!ok) {
    throw new Error(
      `Node ${process.versions.node} cannot build the single binary: module.registerHooks needs 22.15+, 23.5+, or 24+`
    );
  }
}

function run(command, commandArgs, label, options = {}) {
  console.log(`→ ${label}`);
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', cwd: repo, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`);
}

async function smokeTest(binary) {
  console.log('→ smoke test: version, doctor, live server');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-sea-'));
  const env = { ...process.env, SOVEREIGN_HOME: home };
  try {
    const version = spawnSync(binary, ['version'], { encoding: 'utf8', env });
    if (version.status !== 0 || version.stdout.trim() !== VERSION) {
      throw new Error(`binary version check failed: status=${version.status} stdout=${version.stdout} stderr=${version.stderr}`);
    }

    // A fresh home legitimately exits 1 (no model selected yet); what the
    // smoke test proves is that doctor runs to completion inside the binary.
    const doctor = spawnSync(binary, ['doctor', '--no-network'], { encoding: 'utf8', env });
    if (!doctor.stdout.includes(`SovereignAI doctor v${VERSION}`) || !doctor.stdout.includes('Result:')) {
      throw new Error(`binary doctor check failed: status=${doctor.status} stdout=${doctor.stdout} stderr=${doctor.stderr}`);
    }

    const port = await freePort();
    const server = spawn(binary, ['start', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let serverOutput = '';
    server.stdout.on('data', (chunk) => (serverOutput += chunk));
    server.stderr.on('data', (chunk) => (serverOutput += chunk));
    try {
      const status = await pollJson(`http://127.0.0.1:${port}/api/status`, 30_000, () => serverOutput);
      if (status.version !== VERSION) throw new Error(`served version ${status.version} != ${VERSION}`);
      const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      if (!html.includes('<!doctype html>')) throw new Error('embedded web UI was not served');
    } finally {
      const exited = new Promise((resolve) => server.once('exit', resolve));
      server.kill();
      await exited;
    }
  } finally {
    // Windows can briefly hold the SQLite file after the child exits.
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function pollJson(url, timeoutMs, output) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not answer at ${url}: ${lastError}\n--- server output ---\n${output()}`);
}
