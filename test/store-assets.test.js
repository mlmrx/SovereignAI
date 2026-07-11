import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(repo, file));

function pngSize(file) {
  const bytes = read(file);
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${file} must be a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test('every marketplace surface ships a correctly sized brand icon', () => {
  assert.deepEqual(pngSize('integrations/vscode/icon.png'), { width: 128, height: 128 });
  for (const size of [16, 32, 48, 128]) {
    assert.deepEqual(pngSize(`integrations/browser/icons/icon-${size}.png`), { width: size, height: size });
  }
  assert.match(read('integrations/jetbrains/src/main/resources/META-INF/pluginIcon.svg').toString(), /<svg /);
  assert.match(read('assets/icon.svg').toString(), /<svg /);
});

test('store manifests reference the shipped icons', () => {
  const vscode = JSON.parse(read('integrations/vscode/package.json'));
  assert.equal(vscode.icon, 'icon.png');

  const manifest = JSON.parse(read('integrations/browser/manifest.json'));
  for (const size of ['16', '32', '48', '128']) {
    assert.equal(manifest.icons[size], `icons/icon-${size}.png`);
    assert.equal(manifest.action.default_icon[size], `icons/icon-${size}.png`);
  }
});

test('the packaged browser zip includes the icons directory', () => {
  const release = read('.github/workflows/release.yml').toString();
  assert.match(release, /manifest\.json background\.js popup\.html popup\.js icons/);
});

test('store submission guide covers all four marketplaces', () => {
  const guide = read('docs/STORE_SUBMISSION.md').toString();
  for (const marketplace of ['VS Code Marketplace', 'Open VSX', 'Chrome Web Store', 'Firefox Add-ons', 'JetBrains Marketplace']) {
    assert.ok(guide.includes(marketplace), `guide must cover ${marketplace}`);
  }
});
