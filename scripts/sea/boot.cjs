'use strict';
// Single-executable (SEA) entry stub. Node requires the SEA main script to be
// CommonJS, but SovereignAI is an ES-module app — so this stub registers
// synchronous module hooks that serve the embedded module graph from SEA
// assets under a virtual URL scheme, then imports the real CLI through it.
// No source files, temp extraction, or npm packages are involved at runtime.
const { registerHooks } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const sea = require('node:sea');

const SCHEME = 'sovereignai-app:';
const ENTRY_URL = `${SCHEME}/bin/sovereign.js`;
const ASSET_READER = Symbol.for('sovereignai.sea-assets');

// readAsset(key) -> module source string, or undefined when the key is not embedded.
function registerAppHooks(readAsset) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith(SCHEME)) return { url: specifier, shortCircuit: true };
      const parent = context?.parentURL;
      if (parent?.startsWith(SCHEME) && (specifier.startsWith('./') || specifier.startsWith('../'))) {
        return { url: new URL(specifier, parent).href, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (!url.startsWith(SCHEME)) return nextLoad(url, context);
      const key = url.slice(SCHEME.length).replace(/^\/+/, '');
      const source = readAsset(key);
      if (source === undefined) throw new Error(`Embedded module missing from this build: ${key}`);
      return { format: 'module', source, shortCircuit: true };
    },
  });
}

// The binary is an installed artifact, so it keeps the same stable home the
// install scripts use; an explicit SOVEREIGN_HOME always wins.
function stableHome(env, platform, homedir) {
  if (env.SOVEREIGN_HOME) return env.SOVEREIGN_HOME;
  if (platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local'), 'SovereignAI');
  }
  return path.join(homedir, '.sovereignai');
}

function main() {
  // A standalone binary has no way to pass --no-warnings, and the embedded
  // node:sqlite / SEA experimental warnings are not actionable for end users.
  process.removeAllListeners('warning');
  process.on('warning', (warning) => {
    if (warning.name !== 'ExperimentalWarning') console.warn(warning);
  });

  process.env.SOVEREIGN_HOME = stableHome(process.env, process.platform, os.homedir());

  const readAsset = (key, encoding) => {
    try {
      return sea.getAsset(key, encoding);
    } catch {
      return undefined;
    }
  };
  globalThis[ASSET_READER] = (key) => readAsset(key); // web UI bytes for src/static-assets.js
  registerAppHooks((key) => readAsset(key, 'utf8'));

  import(ENTRY_URL).catch((err) => {
    console.error(`SovereignAI failed to start: ${err?.stack ?? err}`);
    process.exit(1);
  });
}

if (sea.isSea()) main();

module.exports = { SCHEME, ENTRY_URL, ASSET_READER, registerAppHooks, stableHome };
