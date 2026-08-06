import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectSeaAssets, collectModuleGraph, isPublicUiPath, moduleSpecifiers, SEA_ENTRY } from '../scripts/sea/manifest.mjs';
import { readPublicFile, normalizeRelPath, SEA_ASSET_READER } from '../src/static-assets.js';
import { VERSION } from '../src/config.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const boot = createRequire(import.meta.url)('../scripts/sea/boot.cjs');

test('SEA manifest embeds the full module graph and the entire web UI', () => {
  const { entry, assets } = collectSeaAssets(repo);
  assert.equal(entry, SEA_ENTRY);

  for (const required of [
    'bin/sovereign.js',
    'src/server.js',
    'src/static-assets.js',
    'src/mcp.js',
    'src/personas.js',
    'src/providers/index.js',
    'public/index.html',
  ]) {
    assert.ok(assets[required], `missing required asset ${required}`);
  }
  for (const uiFile of fs.readdirSync(path.join(repo, 'public'))) {
    if (!isPublicUiPath(uiFile)) continue; // landing-deploy scaffolding, not app UI
    assert.ok(assets[`public/${uiFile}`], `web UI file public/${uiFile} must be embedded`);
  }
  for (const [key, file] of Object.entries(assets)) {
    assert.ok(fs.statSync(file).isFile(), `asset ${key} must resolve to a file`);
    assert.doesNotMatch(key, /\\|^\/|^[A-Za-z]:/, `asset key ${key} must be a posix-relative path`);
    if (key.startsWith('public/')) {
      assert.ok(isPublicUiPath(key.slice('public/'.length)), `deploy scaffolding ${key} must not be embedded`);
    }
  }
});

test('SEA embed and the static server both refuse deploy scaffolding and hidden files', () => {
  for (const scaffolding of ['.vercel/project.json', '.vercelignore', '.env.local', '.gitignore', 'vercel.json', 'api/access-request.js']) {
    assert.equal(isPublicUiPath(scaffolding), false, `${scaffolding} must not count as web UI`);
  }
  assert.ok(isPublicUiPath('land.html') && isPublicUiPath('index.html'), 'the real UI must still count');
});

test('SEA module graph walker sees every import form and rejects bad specifiers', () => {
  assert.deepEqual(
    moduleSpecifiers(
      `import a from './a.js';\nexport { b } from '../b.js';\nconst c = await import('./c.js');\nimport './d.js';\nconst notAnImport = 'import';\nswitch (x) { case 'import': break; }`
    ).sort(),
    ['../b.js', './a.js', './c.js', './d.js']
  );
  assert.throws(() => collectModuleGraph(repo, 'src/nope.js'), /does not exist/);
});

test('SEA boot hooks load the real ES-module graph through the virtual scheme', async () => {
  boot.registerAppHooks((key) => {
    try {
      return fs.readFileSync(path.join(repo, key), 'utf8');
    } catch {
      return undefined;
    }
  });

  const config = await import(`${boot.SCHEME}/src/config.js`);
  assert.equal(config.VERSION, VERSION);

  // server.js pulls in nearly the whole graph via relative imports
  const server = await import(`${boot.SCHEME}/src/server.js`);
  assert.equal(typeof server.createApp, 'function');
  assert.equal(typeof server.startServer, 'function');

  await assert.rejects(import(`${boot.SCHEME}/src/does-not-exist.js`), /Embedded module missing/);
});

test('SEA binary keeps the installed-launcher stable home unless overridden', () => {
  assert.equal(boot.stableHome({ SOVEREIGN_HOME: '/custom' }, 'win32', '/home/u'), '/custom');
  assert.equal(
    boot.stableHome({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32', 'C:\\Users\\u'),
    path.join('C:\\Users\\u\\AppData\\Local', 'SovereignAI')
  );
  assert.equal(boot.stableHome({}, 'win32', 'C:\\Users\\u'), path.join('C:\\Users\\u', 'AppData', 'Local', 'SovereignAI'));
  assert.equal(boot.stableHome({}, 'linux', '/home/u'), path.join('/home/u', '.sovereignai'));
  assert.equal(boot.stableHome({}, 'darwin', '/Users/u'), path.join('/Users/u', '.sovereignai'));
});

test('static assets read from disk, reject traversal, and prefer an installed SEA reader', () => {
  assert.equal(normalizeRelPath('style.css'), 'style.css');
  assert.equal(normalizeRelPath('nested/app.js'), 'nested/app.js');
  for (const bad of ['', '../src/config.js', 'a/../b', './x', 'a//b', 'a\\b', 'c:/windows', 'nul\0byte', '/etc/passwd', '.env.local', '.vercel/project.json', 'a/.hidden']) {
    assert.equal(normalizeRelPath(bad), null, `"${bad}" must be rejected`);
  }

  const index = readPublicFile('index.html');
  assert.ok(index.toString('utf8').startsWith('<!doctype html>'));
  assert.equal(readPublicFile('does-not-exist.html'), null);
  assert.equal(readPublicFile('../src/config.js'), null);

  globalThis[SEA_ASSET_READER] = (key) => (key === 'public/embedded.txt' ? new TextEncoder().encode('from-sea') : undefined);
  try {
    assert.equal(readPublicFile('embedded.txt').toString('utf8'), 'from-sea');
    assert.equal(readPublicFile('index.html'), null, 'SEA mode must not fall back to the source tree');
  } finally {
    delete globalThis[SEA_ASSET_READER];
  }
  assert.ok(readPublicFile('index.html'), 'disk mode must return after the reader is removed');
});

test('CI and release workflows build, smoke-test, and publish the single binaries', () => {
  const ci = fs.readFileSync(path.join(repo, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /run: node scripts\/build-sea\.mjs/);

  const release = fs.readFileSync(path.join(repo, '.github/workflows/release.yml'), 'utf8');
  assert.match(release, /binaries:/);
  assert.match(release, /needs: \[test, artifacts\]/);
  for (const os of ['ubuntu-latest', 'windows-latest', 'macos-latest']) {
    assert.ok(release.includes(os), `release binaries must cover ${os}`);
  }
  assert.match(release, /run: node scripts\/build-sea\.mjs/);
  assert.match(release, /gh release upload "\$GITHUB_REF_NAME" dist\/sovereign-v\* --clobber/);
});
