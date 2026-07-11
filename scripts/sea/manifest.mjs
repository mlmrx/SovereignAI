// Collects everything a single-executable (SEA) build must embed: the
// ES-module graph reachable from bin/sovereign.js — static, re-export, and
// literal dynamic imports — plus every web UI file under public/.
//
// The walker is deliberately strict: a bare specifier, an unresolvable
// relative import, or a file outside the repository fails the build instead
// of producing a binary with a hole in it.
import fs from 'node:fs';
import path from 'node:path';

export const SEA_ENTRY = 'bin/sovereign.js';

const IMPORT_PATTERNS = [
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import('...')
  /\b(?:import|export)\s+[^'";()]*?\bfrom\s*['"]([^'"]+)['"]/g, // static import / re-export
  /(?<!['"])\bimport\s+['"]([^'"]+)['"]/g, // side-effect import (not the word 'import' inside a string)
];

export function moduleSpecifiers(source) {
  const found = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

export function collectModuleGraph(repoRoot, entry = SEA_ENTRY) {
  const root = path.resolve(repoRoot);
  const keys = new Set();
  const queue = [entry];
  while (queue.length) {
    const key = queue.shift();
    if (keys.has(key)) continue;
    const file = path.join(root, key);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`SEA module graph: ${key} does not exist`);
    }
    keys.add(key);
    for (const specifier of moduleSpecifiers(fs.readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('node:')) continue;
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
        throw new Error(`SEA module graph: unsupported specifier "${specifier}" in ${key}`);
      }
      const resolved = path.normalize(path.join(path.dirname(file), specifier));
      const relative = path.relative(root, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`SEA module graph: "${specifier}" in ${key} escapes the repository`);
      }
      queue.push(relative.split(path.sep).join('/'));
    }
  }
  return [...keys].sort();
}

export function collectPublicFiles(repoRoot) {
  const publicDir = path.join(path.resolve(repoRoot), 'public');
  return fs
    .readdirSync(publicDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const rel = path.relative(publicDir, path.join(entry.parentPath ?? entry.path, entry.name));
      return `public/${rel.split(path.sep).join('/')}`;
    })
    .sort();
}

// Returns { entry, assets } where assets maps embedded asset keys (posix
// repo-relative paths) to absolute source file paths.
export function collectSeaAssets(repoRoot) {
  const root = path.resolve(repoRoot);
  const assets = {};
  for (const key of [...collectModuleGraph(root), ...collectPublicFiles(root)]) {
    assets[key] = path.join(root, key);
  }
  return { entry: SEA_ENTRY, assets };
}
