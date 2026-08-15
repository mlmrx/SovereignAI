// Regenerates the checked-in brand icons for the web UI favicon geometry:
// a Claude-terracotta hexagon (#d97757) carrying the warm-charcoal glyph
// (#1f1e1d) from public/app.html. Zero dependencies — polygons are
// rasterized with 4x4 supersampling and encoded as PNG by hand.
//
//   node scripts/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const GOLD = [0xd9, 0x77, 0x57, 0xff]; // Claude terracotta
const DARK = [0x1f, 0x1e, 0x1d, 0xff]; // warm charcoal
// Both shapes live in the favicon's 100x100 viewBox.
const HEXAGON = [
  [50, 4],
  [90, 27],
  [90, 73],
  [50, 96],
  [10, 73],
  [10, 27],
];
const GLYPH = [
  [34, 29],
  [68, 29],
  [68, 39],
  [45, 39],
  [45, 46],
  [63, 46],
  [63, 56],
  [45, 56],
  [45, 63],
  [68, 63],
  [68, 73],
  [34, 73],
];

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path fill="#d97757" d="M50 4 90 27v46L50 96 10 73V27z"/>
  <path fill="#1f1e1d" d="M34 29h34v10H45v7h18v10H45v7h23v10H34z"/>
</svg>
`;

const outputs = [
  { file: 'assets/icon.svg', svg: SVG },
  { file: 'integrations/jetbrains/src/main/resources/META-INF/pluginIcon.svg', svg: SVG },
  { file: 'integrations/vscode/icon.png', size: 128 },
  { file: 'integrations/browser/icons/icon-16.png', size: 16 },
  { file: 'integrations/browser/icons/icon-32.png', size: 32 },
  { file: 'integrations/browser/icons/icon-48.png', size: 48 },
  { file: 'integrations/browser/icons/icon-128.png', size: 128 },
];

for (const output of outputs) {
  const target = path.join(repo, output.file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, output.svg ?? renderPng(output.size));
  console.log(`wrote ${output.file}`);
}

function renderPng(size) {
  const SS = 4; // supersampling grid per axis
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = ((x + (sx + 0.5) / SS) / size) * 100;
          const py = ((y + (sy + 0.5) / SS) / size) * 100;
          let color = null;
          if (insidePolygon(px, py, HEXAGON)) color = insidePolygon(px, py, GLYPH) ? DARK : GOLD;
          if (color) {
            // accumulate premultiplied so transparent samples don't tint edges
            r += color[0] * color[3];
            g += color[1] * color[3];
            b += color[2] * color[3];
            a += color[3];
          }
        }
      }
      const offset = (y * size + x) * 4;
      const samples = SS * SS;
      pixels[offset] = a ? Math.round(r / a) : 0;
      pixels[offset + 1] = a ? Math.round(g / a) : 0;
      pixels[offset + 2] = a ? Math.round(b / a) : 0;
      pixels[offset + 3] = Math.round(a / samples);
    }
  }

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function insidePolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
