import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// In a source checkout the web UI is read from public/ on disk. In a
// single-executable (SEA) build there is no source tree: the boot stub
// installs a reader under this well-known symbol that resolves the same
// repo-relative keys (e.g. "public/app.html") from embedded assets.
export const SEA_ASSET_READER = Symbol.for('sovereignai.sea-assets');

// In a SEA binary this module has a virtual (non-file:) URL and no public/
// directory on disk — the embedded-asset reader below is used instead.
const PUBLIC_DIR = (() => {
  try {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
  } catch {
    return null;
  }
})();

// Accepts only plain forward-slash relative paths; anything empty, absolute,
// dotted, or platform-tricky (backslash, NUL, drive colon) is rejected so the
// URL pathname can be used directly without a separate traversal guard.
// Dot-leading segments are rejected wholesale: public/ doubles as the landing
// deploy root, and tooling drops files like .vercel/ and .env.local there —
// hidden files must never be servable.
export function normalizeRelPath(rel) {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\\') || rel.includes('\0') || rel.includes(':')) return null;
  const segments = rel.split('/');
  if (segments.some((segment) => segment === '' || segment.startsWith('.'))) return null;
  return segments.join('/');
}

export function readPublicFile(rel) {
  const key = normalizeRelPath(rel);
  if (key === null) return null;

  const reader = globalThis[SEA_ASSET_READER];
  if (typeof reader === 'function') {
    const found = reader(`public/${key}`);
    return found == null ? null : Buffer.from(found);
  }

  if (PUBLIC_DIR === null) return null;
  const file = path.join(PUBLIC_DIR, key);
  try {
    if (!fs.statSync(file).isFile()) return null;
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}
