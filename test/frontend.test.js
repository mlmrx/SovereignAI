import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createApp } from '../src/server.js';

const root = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'app.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const finetuneJs = fs.readFileSync(path.join(root, 'public', 'finetune.js'), 'utf8');
const wizardJs = fs.readFileSync(path.join(root, 'public', 'wizard.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');

test('command center markup has unique ids and every app selector resolves', () => {
  const ids = [...html.matchAll(/\bid="([A-Za-z][\w:-]*)"/g)].map((match) => match[1]);
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  assert.deepEqual(duplicates, [], `duplicate ids: ${duplicates.join(', ')}`);

  const referencedIds = [...appJs.matchAll(/\$\(['"]#([A-Za-z][\w-]*)['"]/g)].map((match) => match[1]);
  const missing = [...new Set(referencedIds.filter((id) => !ids.includes(id)))];
  assert.deepEqual(missing, [], `app selectors missing from app.html: ${missing.join(', ')}`);

  for (const required of ['view-home', 'readiness-panel', 'source-panel', 'drop-zone', 'memory-form', 'confirm-dialog']) {
    if (required === 'source-panel') assert.match(appJs, /className = 'source-panel'/);
    else assert.ok(ids.includes(required), `missing ${required}`);
  }
});

test('command center browser bundle parses and Model Studio controls are wired', () => {
  assert.doesNotThrow(() => new vm.Script(appJs, { filename: 'public/app.js' }));
  for (const functionName of ['loadModelRecipes', 'renderModelOwnership', 'collectModelRecipeForm', 'saveModelRecipe']) {
    assert.match(appJs, new RegExp(`function\\s+${functionName}\\s*\\(`), `missing ${functionName}`);
  }
  const bindings = {
    'model-recipe-form': 'submit',
    'model-new-btn': 'click',
    'model-import-btn': 'click',
    'model-import-file': 'change',
    'model-download-btn': 'click',
    'model-modelfile-btn': 'click',
    'model-delete-btn': 'click',
    'model-build-btn': 'click',
    'model-stop-add': 'click',
    'model-message-add': 'click',
  };
  for (const [id, event] of Object.entries(bindings)) {
    assert.match(appJs, new RegExp(`\\$\\('#${id}'\\)\\.addEventListener\\('${event}'`), `${id} must handle ${event}`);
  }
  assert.doesNotMatch(appJs, /#bake-(?:btn|name|base|system|status)/);
  assert.match(appJs, /beforeunload[\s\S]*modelRecipeDirty/);
  assert.match(html, /id="model-message-list"/);
  assert.match(html, /id="model-stop-list"/);
  assert.match(appJs, /function\s+modelStopsFromForm[\s\S]*content\.length === 0/, 'stop sequences must preserve whitespace and line breaks');
  assert.match(css, /@media \(max-width: 1100px\)[\s\S]*\.model-studio\s*\{\s*grid-template-columns:\s*1fr/);
});

test('Fine-Tuning Studio bundle parses and keeps consent, lineage, and run controls wired', () => {
  assert.doesNotThrow(() => new vm.Script(finetuneJs, { filename: 'public/finetune.js' }));
  for (const id of [
    'view-finetune', 'ft-new-btn', 'ft-project-list', 'ft-project-form', 'ft-source-list',
    'ft-prepare-btn', 'ft-example-editor', 'ft-lock-btn', 'ft-trainer-save', 'ft-trainer-check',
    'ft-start-btn', 'ft-refresh-run', 'ft-cancel-btn', 'ft-eval-save', 'ft-deploy-btn',
  ]) assert.match(html, new RegExp(`id="${id}"`), `missing ${id}`);
  for (const id of [
    'ft-new-btn', 'ft-delete-btn', 'ft-refresh-sources', 'ft-prepare-btn', 'ft-lock-btn',
    'ft-trainer-save', 'ft-trainer-check', 'ft-start-btn', 'ft-refresh-run', 'ft-cancel-btn',
    'ft-eval-save', 'ft-deploy-btn',
  ]) assert.ok(finetuneJs.includes(`bindClick('${id}'`), `${id} must be bound`);
  assert.match(finetuneJs, /window\.SOVEREIGN_FINE_TUNE\s*=\s*\{\s*load,\s*isDirty\s*\}/);
  assert.ok(
    finetuneJs.indexOf('const sourceRefs = selectedSources()') < finetuneJs.indexOf('if (!current?.id || projectDirty) await saveProject'),
    'source and consent choices must be captured before project save re-renders the form'
  );
  assert.match(finetuneJs, /BLOCKING_RUN_STATES[\s\S]*'unreachable'/);
  assert.doesNotMatch(finetuneJs, /'host\.docker\.internal'.*includes\(host\)/);
  assert.match(finetuneJs, /payload\.trainJsonl/);
  assert.match(finetuneJs, /payload\.evalJsonl/);
  assert.match(finetuneJs, /sovereignai\.training-export\/v1/);
  assert.match(css, /\.ft-page-body/);
});

test('onboarding requires an OpenAI model and keeps automatic memory opt-in', () => {
  assert.match(html, /id="wz-openai-model"/);
  assert.match(wizardJs, /Enter the exact model ID/);
  const memoryInput = html.match(/<input[^>]*id="wz-auto-memory"[^>]*>/)?.[0] || '';
  assert.ok(memoryInput, 'missing automatic-memory choice');
  assert.doesNotMatch(memoryInput, /\bchecked\b/, 'automatic memory must not be preselected');
  assert.match(wizardJs, /profile\.disclosure/);
  assert.match(wizardJs, /api\('GET', '\/api\/config'/, 'wizard must inspect the configured Ollama endpoint');
  assert.match(wizardJs, /Configured endpoint \/ Ollama/);
  assert.doesNotMatch(html, /Ollama[^<]*\u00b7 local|prompts stay on this machine/i);
  assert.match(wizardJs, /provider === 'openai' \|\| provider === 'ollama'/);
});

test('wizard provider choices use unambiguous labels with a non-:has fallback', () => {
  assert.doesNotMatch(html, /<label\s+class="wz-choice"/, 'a provider label must not wrap its nested model or key fields');
  for (const provider of ['ollama', 'anthropic', 'openai']) {
    assert.match(html, new RegExp(`id="wz-provider-${provider}"[^>]*name="wz-provider"`));
    assert.match(html, new RegExp(`class="provider-choice-label"\\s+for="wz-provider-${provider}"`));
    assert.match(html, new RegExp(`data-provider-fields="${provider}"`));
  }
  assert.match(css, /\.wz-choice\.selected\s+\.provider-fields/);
});

test('destructive confirmation and async navigation guards remain fail-safe', () => {
  assert.match(appJs, /dialog\.returnValue\s*=\s*'cancel'[\s\S]*?dialog\.showModal\(\)/);
  assert.match(appJs, /stopStreaming\(\{\s*silent:\s*true,\s*abandon:\s*true\s*\}\)/);
  assert.match(appJs, /conversationRequestId/);
  assert.match(appJs, /knowledgeSearchId/);
  assert.match(appJs, /modelRequestId/);
  assert.match(appJs, /#persona-select'\)\.disabled\s*=\s*streaming/);
  assert.match(appJs, /button\.closest\('\.settings-nav'\)/);
  assert.match(appJs, /if \(route\) showView\(route/);
  assert.match(html, /<main id="main" tabindex="-1">/);
});

test('frontend compatibility and stored-data rendering guards remain wired', () => {
  assert.match(appJs, /memoryToken/);
  assert.match(appJs, /typeof Intl\.RelativeTimeFormat !== 'function'/);
  assert.doesNotMatch(appJs, /\.at\(-1\)/);
  assert.match(appJs, /legacyCopyText/);
  assert.match(appJs, /value="\$\{escapeHtml\(persona\.temperature/);
  assert.match(appJs, /requestAnimationFrame\(\(\) => \{/);
  assert.match(appJs, /followAfterRender/);
  assert.match(appJs, /resolvedProvider === defaults\.provider \? defaults\.model : null/);
});

test('chat and responsive UX contracts remain wired', () => {
  assert.match(appJs, /new AbortController\(\)/);
  assert.match(appJs, /stopStreaming/);
  assert.match(appJs, /renderSources/);
  assert.match(appJs, /#token=/);
  assert.match(css, /@media \(max-width: 860px\)/);
  assert.match(css, /body\.sidebar-open #sidebar/);
  assert.match(css, /\[hidden\] \{ display: none !important; \}/);
  assert.match(css, /prefers-reduced-motion/);
});

test('static app is served with restrictive browser security headers', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-frontend-'));
  const { server, store } = createApp(home, { hardware: { detectGpu: async () => null } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy') || '', /script-src 'self'/);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.match(await response.text(), /id="view-home"/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('moving between views is real navigation: back and forward retrace it', () => {
  const script = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  // replaceState left no history entry, so the browser's back button jumped
  // straight out of the app instead of to the previous view.
  assert.match(
    script,
    /if \(updateHash && location\.hash !== `#\/\$\{name\}`\) history\.pushState/,
    'a view change must push a history entry'
  );
  assert.doesNotMatch(script, /history\.replaceState\(null, '', `#\/\$\{name\}`\)/, 'no view change may replace the entry');
  // Restoring a route must not add one, or back would need two presses.
  assert.match(script, /showView\(route, \{ updateHash: false \}\)/, 'hash-driven restores add no entry');
});
