#!/usr/bin/env node
// Assemble the static landing site for static hosts (Vercel, Netlify, Pages).
// The full app needs a persistent Node server and a local SQLite database, so
// only the self-contained landing page ships to static hosting: land.html
// becomes index.html and brings its one script along.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'dist-site');
const files = { 'land.html': 'index.html', 'land.js': 'land.js' };

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const [src, dest] of Object.entries(files)) {
  fs.copyFileSync(path.join(root, 'public', src), path.join(out, dest));
}
console.log(`Static landing site written to ${out} (${Object.keys(files).length} files)`);
