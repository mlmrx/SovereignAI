import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', 'integrations', 'jetbrains');
const api = fs.readFileSync(path.join(root, 'src', 'main', 'kotlin', 'ai', 'sovereign', 'plugin', 'SovereignApi.kt'), 'utf8');
const panel = fs.readFileSync(path.join(root, 'src', 'main', 'kotlin', 'ai', 'sovereign', 'plugin', 'SovereignToolWindowFactory.kt'), 'utf8');

test('JetBrains client supports secured and non-default SovereignAI servers', () => {
  assert.match(api, /System\.getenv\("SOVEREIGN_URL"\)/);
  assert.match(api, /System\.getenv\("SOVEREIGN_TOKEN"\)/);
  assert.match(api, /token\.takeIf \{ serverUrl\(\) == tokenServer \}/);
  assert.match(api, /header\("Authorization", "Bearer \$it"\)/);
  assert.doesNotMatch(panel, /Private\. Local\. Yours\./);
});
