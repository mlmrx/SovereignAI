/* SovereignAI Fine-Tuning Studio — resumable, explicit-consent, local/self-hosted workflow. */
(function () {
  'use strict';

  const STEP_IDS = [
    'ft-step-goal',
    'ft-step-data',
    'ft-step-review',
    'ft-step-train',
    'ft-step-evaluate',
    'ft-step-deploy',
  ];
  const STEP_KEYS = ['goal', 'data', 'review', 'train', 'evaluate', 'deploy'];
  const STEP_LABELS = ['Goal', 'Data & consent', 'Review & redact', 'Train', 'Evaluate', 'Deploy'];
  const ACTIVE_RUN_STATES = new Set(['preparing', 'uploading', 'queued', 'starting', 'running', 'training', 'evaluating', 'exporting', 'saving', 'cancel_requested', 'cancelling']);
  const BLOCKING_RUN_STATES = new Set([...ACTIVE_RUN_STATES, 'unreachable']);
  const COMPLETE_RUN_STATES = new Set(['complete', 'completed', 'succeeded', 'success', 'trained']);
  const APPROVED_DECISIONS = new Set(['approve', 'approved', 'deploy', 'prefer_tuned', 'tuned']);
  const DEPLOYABLE_DECISIONS = new Set([...APPROVED_DECISIONS, 'skipped']);

  let initialized = false;
  let loaded = false;
  let loadPromise = null;
  let projects = [];
  let sources = [];
  let capabilities = null;
  let current = null;
  let examples = [];
  let selectedExampleId = null;
  let step = 0;
  let projectDirty = false;
  let exampleDirty = false;
  let busy = false;
  let pollTimer = null;
  let projectRequest = 0;

  function app() {
    return window.SOVEREIGN_APP || {};
  }

  function byId(id) {
    try { return app().$?.(`#${id}`) || document.getElementById(id); }
    catch { return document.getElementById(id); }
  }

  function all(selector, root = document) {
    try { return app().$$?.(selector, root) || [...root.querySelectorAll(selector)]; }
    catch { return [...root.querySelectorAll(selector)]; }
  }

  function esc(value = '') {
    if (typeof app().escapeHtml === 'function') return app().escapeHtml(value);
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function uiIcon(name) {
    return typeof app().icon === 'function'
      ? app().icon(name)
      : `<svg class="icon" aria-hidden="true"><use href="#i-${esc(name)}"/></svg>`;
  }

  function notify(message, options = {}) {
    if (typeof app().toast === 'function') app().toast(message, options);
  }

  function dateLabel(value) {
    if (!value) return '';
    if (typeof app().formatDate === 'function') return app().formatDate(value, { relative: true });
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
  }

  async function confirmUi(options) {
    if (typeof app().confirmAction === 'function') return app().confirmAction(options);
    return window.confirm(`${options.title || 'Continue?'}\n\n${options.message || ''}`);
  }

  async function request(method, path, body) {
    const client = app().api;
    if (!client) throw new Error('The SovereignAI API client is not available. Reload the workspace and try again.');
    if (method === 'GET' && typeof client.get === 'function') return client.get(path);
    if (typeof client.send === 'function') return client.send(method, path, body);
    if (typeof client.request === 'function') return client.request(method, path, body);
    throw new Error('The SovereignAI API client does not support this request.');
  }

  function unwrap(payload, key) {
    if (payload && typeof payload === 'object' && payload[key] !== undefined) return payload[key];
    return payload;
  }

  function setStatus(message = '', type = '') {
    const host = byId('ft-status');
    if (!host) return;
    host.textContent = message;
    host.className = `ft-status${type ? ` ${type}` : ''}`;
    host.setAttribute('role', type === 'error' ? 'alert' : 'status');
    host.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
  }

  function errorMessage(error) {
    return error instanceof Error && error.message ? error.message : String(error || 'Unexpected error');
  }

  function handleError(error, title = 'Fine-tuning action failed') {
    const message = errorMessage(error);
    setStatus(message, 'error');
    notify(message, { type: 'error', title });
  }

  function setBusy(next) {
    busy = Boolean(next);
    const flow = byId('ft-flow');
    if (flow) flow.setAttribute('aria-busy', String(busy));
    for (const control of all('[data-ft-busy], #ft-prepare-btn, #ft-lock-btn, #ft-train-btn, #ft-start-btn, #ft-evaluate-btn, #ft-eval-save, #ft-deploy-btn')) {
      if (!control.matches('#ft-run-cancel-btn, #ft-cancel-btn')) control.disabled = busy;
    }
    syncActions();
  }

  async function runBusy(action) {
    if (busy) return null;
    setBusy(true);
    try { return await action(); }
    finally { setBusy(false); }
  }

  function currentRun() {
    if (!current) return null;
    if (current.run) return current.run;
    if (Array.isArray(current.runs) && current.runs.length) return current.runs[0];
    if (current.run_id) return {
      id: current.run_id,
      status: current.run_status || current.status,
      progress: current.progress,
      stage: current.stage,
      metrics: current.metrics,
      artifact: current.artifact,
      evaluation_decision: current.evaluation_decision,
      evaluation_notes: current.evaluation_notes,
      deployed_at: current.deployed_at,
    };
    return null;
  }

  function currentDataset() {
    if (!current) return null;
    if (current.dataset) return current.dataset;
    if (Array.isArray(current.datasets) && current.datasets.length) return current.datasets[0];
    if (current.dataset_id) return { id: current.dataset_id };
    return null;
  }

  function currentEvaluation() {
    const run = currentRun();
    if (current?.evaluation) return current.evaluation;
    if (run?.evaluation) return run.evaluation;
    if (run?.metrics || run?.evaluation_decision || run?.evaluation_notes) {
      return {
        metrics: run.metrics || {},
        decision: run.evaluation_decision || null,
        notes: run.evaluation_notes || '',
      };
    }
    return null;
  }

  function currentDeployment() {
    const run = currentRun();
    if (current?.deployment) return current.deployment;
    if (run?.deployment) return run.deployment;
    if (run?.artifact || run?.deployed_at) {
      return {
        status: run.deployed_at ? 'deployed' : 'ready',
        artifact: run.artifact,
        deployed_at: run.deployed_at,
        persona_id: run.deployed_persona_id,
      };
    }
    return null;
  }

  function runState(run = currentRun()) {
    return String(run?.status || run?.state || '').toLowerCase();
  }

  function evaluationDecision(evaluation = currentEvaluation()) {
    return String(evaluation?.decision || currentRun()?.evaluation_decision || current?.evaluation_decision || '').toLowerCase();
  }

  function deploymentComplete(deployment = currentDeployment()) {
    const status = String(deployment?.status || deployment?.state || current?.status || '').toLowerCase();
    return Boolean(deployment?.deployed_at || ['deployed', 'complete', 'completed', 'succeeded'].includes(status));
  }

  function highestAvailableStep(project = current) {
    if (!project?.id) return 0;
    let available = 1;
    const prepared = examples.length > 0 || Number(project.example_count || project.examples_count || 0) > 0 || project.prepared_at;
    if (prepared) available = 2;
    if (currentDataset()) available = 3;
    if (COMPLETE_RUN_STATES.has(runState())) available = 4;
    if (DEPLOYABLE_DECISIONS.has(evaluationDecision())) available = 5;
    if (deploymentComplete()) available = 5;

    const persisted = Number(project.current_step ?? project.step);
    if (Number.isInteger(persisted)) available = Math.max(available, Math.min(5, persisted));
    return Math.min(5, available);
  }

  function projectSummary(value = {}) {
    return {
      id: value.id,
      title: value.title || value.name || 'Untitled fine-tune',
      goal: value.goal || '',
      base_model: value.base_model || value.baseModel || value.base || '',
      status: value.status || 'draft',
      updated_at: value.updated_at || value.updatedAt || value.created_at,
    };
  }

  function applyPayload(payload, { render = true } = {}) {
    if (!payload) return current;
    const directProject = payload.id && (payload.title !== undefined || payload.goal !== undefined || payload.base_model !== undefined);
    const project = payload.project || (directProject ? payload : null);
    if (project) current = { ...(current || {}), ...project };
    if (!current) current = {};

    const nextExamples = payload.examples || payload.training_examples || project?.examples || project?.training_examples;
    if (Array.isArray(nextExamples)) examples = nextExamples;
    if (payload.dataset) current.dataset = payload.dataset;
    if (payload.datasets) current.datasets = payload.datasets;
    if (payload.run) current.run = payload.run;
    if (payload.runs) current.runs = payload.runs;
    if (!payload.run && payload.dataset_id && payload.remote_job_id !== undefined) current.run = payload;
    if (!payload.dataset && payload.train_count !== undefined && payload.eval_count !== undefined) current.dataset = payload;
    if (payload.evaluation) current.evaluation = payload.evaluation;
    if (payload.deployment) current.deployment = payload.deployment;

    if (current.id) {
      const summary = projectSummary(current);
      projects = [summary, ...projects.filter((item) => item.id !== summary.id)];
    }
    if (render) renderAll();
    return current;
  }

  function projectField(ids, names = []) {
    for (const id of ids) {
      const element = byId(id);
      if (element) return element;
    }
    const form = byId('ft-project-form');
    if (!form) return null;
    for (const name of names) {
      const element = form.elements?.namedItem(name);
      if (element) return element;
    }
    return null;
  }

  function fields() {
    return {
      title: projectField(['ft-project-title', 'ft-title'], ['title', 'name']),
      goal: projectField(['ft-project-goal', 'ft-goal'], ['goal']),
      base: projectField(['ft-base-model', 'ft-project-base-model', 'ft-project-base'], ['base_model', 'baseModel', 'base']),
      persona: projectField(['ft-target-persona', 'ft-project-persona'], ['target_persona_id', 'targetPersonaId', 'persona_id']),
      method: projectField(['ft-method'], ['method']),
    };
  }

  function projectFormValue() {
    const controls = fields();
    return {
      title: controls.title?.value?.trim() || current?.title || '',
      goal: controls.goal?.value?.trim() || current?.goal || '',
      base_model: controls.base?.value?.trim() || current?.base_model || current?.base || '',
      target_persona_id: controls.persona?.value || current?.target_persona_id || null,
      method: controls.method?.value || current?.method || 'sft-qlora',
    };
  }

  function markInvalid(control, invalid, descriptionId = '') {
    if (!control) return;
    if (invalid) {
      control.setAttribute('aria-invalid', 'true');
      if (descriptionId) control.setAttribute('aria-describedby', descriptionId);
    } else {
      control.removeAttribute('aria-invalid');
    }
  }

  function validateGoal() {
    const value = projectFormValue();
    const controls = fields();
    const required = [
      [controls.title, value.title, 'Name this fine-tuning project.'],
      [controls.goal, value.goal, 'Describe the behavior or task you want to improve.'],
      [controls.base, value.base_model, 'Choose a base model supported by your local trainer.'],
    ];
    for (const [control, content, message] of required) {
      markInvalid(control, !content);
      if (!content) {
        setStatus(message, 'error');
        control?.focus();
        return false;
      }
    }
    return true;
  }

  function populatePersonas() {
    const selects = [fields().persona, byId('ft-deploy-persona')].filter(Boolean);
    const personas = Array.isArray(app().state?.personas) ? app().state.personas : [];
    for (const select of selects) {
      if (select.tagName !== 'SELECT') continue;
      select.innerHTML = `<option value="">${select.id === 'ft-deploy-persona' ? 'Choose a persona' : 'Choose later'}</option>${personas.map((persona) =>
        `<option value="${esc(persona.id)}">${esc(persona.name || 'Unnamed persona')}</option>`
      ).join('')}`;
      const desired = select.id === 'ft-deploy-persona'
        ? currentRun()?.deployed_persona_id || current?.target_persona_id || ''
        : current?.target_persona_id || '';
      if (desired && [...select.options].some((option) => option.value === desired)) select.value = desired;
      else select.value = '';
    }
  }

  function fillProjectForm() {
    if (!current) return;
    const controls = fields();
    if (controls.title) controls.title.value = current.title || current.name || '';
    if (controls.goal) controls.goal.value = current.goal || '';
    if (controls.base) controls.base.value = current.base_model || current.baseModel || current.base || '';
    if (controls.method) controls.method.value = current.method || 'sft-qlora';
    const locked = Boolean(currentDataset());
    if (controls.base) controls.base.disabled = locked;
    if (controls.method) controls.method.disabled = locked;
    populatePersonas();
    if (controls.persona && current.target_persona_id) controls.persona.value = current.target_persona_id;
  }

  function setDirty(next = true) {
    projectDirty = Boolean(next);
    syncActions();
  }

  function isDirty() {
    return projectDirty || exampleDirty;
  }

  async function discardGuard() {
    if (!isDirty()) return true;
    return confirmUi({
      title: 'Discard unsaved fine-tuning edits?',
      message: 'The current project or example has changes that have not been saved to its local training snapshot.',
      action: 'Discard edits',
    });
  }

  function showFlow(visible = true) {
    const flow = byId('ft-flow');
    if (flow) flow.hidden = !visible;
    const welcome = byId('ft-welcome');
    if (welcome) welcome.hidden = visible;
  }

  function renderProjects() {
    const host = byId('ft-project-list');
    if (!host) return;
    const count = byId('ft-project-count');
    if (count) count.textContent = String(projects.length);
    if (!projects.length) {
      host.innerHTML = '<div class="ft-empty">No fine-tuning projects yet. Start with a behavior or task you can evaluate clearly.</div>';
      return;
    }
    host.innerHTML = projects.map((project) => {
      const status = String(project.status || 'draft').replace(/[_-]+/g, ' ');
      return `<article class="ft-project-card${project.id === current?.id ? ' active' : ''}">
        <button class="ft-project-open" type="button" data-ft-project-id="${esc(project.id)}" aria-label="Open ${esc(project.title)}">
          <span><strong>${esc(project.title)}</strong><small>${esc(project.base_model || 'Base model not selected')}</small></span>
          <span class="ft-project-meta"><span class="ft-badge">${esc(status)}</span><small>${esc(dateLabel(project.updated_at))}</small></span>
        </button>
        <button class="mini-btn danger ft-project-delete" type="button" data-ft-project-delete="${esc(project.id)}" aria-label="Delete ${esc(project.title)}">${uiIcon('trash')}</button>
      </article>`;
    }).join('');
  }

  async function newProject() {
    if (!(await discardGuard())) return;
    stopPolling();
    const defaultModel = app().state?.config?.defaults?.model || '';
    current = { title: '', goal: '', base_model: defaultModel, target_persona_id: null, sources: [] };
    examples = [];
    selectedExampleId = null;
    step = 0;
    projectDirty = false;
    exampleDirty = false;
    showFlow(true);
    const heading = byId('ft-project-heading');
    if (heading) heading.textContent = 'New fine-tuning project';
    fillProjectForm();
    renderAll();
    requestAnimationFrame(() => {
      const heading = byId(STEP_IDS[0])?.querySelector('h2, h3');
      if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      } else fields().title?.focus();
    });
    setStatus('Describe one behavior or task this tuned model should improve.');
  }

  async function saveProject({ quiet = false } = {}) {
    if (!validateGoal()) throw new Error('Complete the highlighted project fields before continuing.');
    const payload = projectFormValue();
    const saved = current?.id
      ? await request('PUT', `/api/training/projects/${encodeURIComponent(current.id)}`, payload)
      : await request('POST', '/api/training/projects', payload);
    applyPayload(saved, { render: false });
    projectDirty = false;
    fillProjectForm();
    renderAll();
    if (!quiet) notify('Fine-tuning project saved locally.', { type: 'success' });
    return current;
  }

  async function openProject(id) {
    if (!id || id === current?.id) return;
    if (!(await discardGuard())) return;
    const requestId = ++projectRequest;
    await runBusy(async () => {
      setStatus('Loading the fine-tuning project…');
      const payload = await request('GET', `/api/training/projects/${encodeURIComponent(id)}`);
      if (requestId !== projectRequest) return;
      current = null;
      examples = [];
      selectedExampleId = null;
      applyPayload(payload, { render: false });
      const detail = payload.project || payload;
      if (Array.isArray(detail?.examples)) examples = detail.examples;
      projectDirty = false;
      exampleDirty = false;
      step = Math.min(highestAvailableStep(), Number(detail.current_step ?? detail.step) || highestAvailableStep());
      showFlow(true);
      const heading = byId('ft-project-heading');
      if (heading) heading.textContent = current.title || 'Fine-tuning project';
      fillProjectForm();
      renderAll();
      setStatus(`Opened “${current.title || 'Untitled fine-tune'}”.`);
      if (ACTIVE_RUN_STATES.has(runState())) schedulePoll();
    }).catch((error) => handleError(error, 'Could not open fine-tuning project'));
  }

  async function deleteProject(id) {
    const project = projects.find((item) => item.id === id);
    if (!project) return;
    const confirmed = await confirmUi({
      title: 'Delete this fine-tuning project?',
      message: `“${project.title}” and its prepared examples, run metadata, and evaluation records will be removed. Trainer-owned checkpoints may require separate cleanup.`,
      action: 'Delete project',
    });
    if (!confirmed) return;
    await runBusy(async () => {
      await request('DELETE', `/api/training/projects/${encodeURIComponent(id)}`);
      projects = projects.filter((item) => item.id !== id);
      if (current?.id === id) {
        stopPolling();
        current = null;
        examples = [];
        selectedExampleId = null;
        showFlow(false);
      }
      renderProjects();
      notify('Fine-tuning project deleted.', { type: 'success' });
    }).catch((error) => handleError(error, 'Could not delete fine-tuning project'));
  }

  function normalizeSources(payload) {
    const raw = unwrap(payload, 'sources');
    if (Array.isArray(raw)) return raw.map(normalizeSource).filter(Boolean);
    if (!raw || typeof raw !== 'object') return [];
    const flattened = [];
    for (const [group, records] of Object.entries(raw)) {
      if (!Array.isArray(records)) continue;
      const type = group.replace(/s$/, '');
      for (const record of records) flattened.push(normalizeSource({ ...record, type: record.type || type }));
    }
    return flattened.filter(Boolean);
  }

  function normalizeSource(source) {
    if (!source || typeof source !== 'object') return null;
    const type = String(source.type || source.kind || 'source').toLowerCase();
    const id = String(source.id || source.source_id || '');
    if (!id) return null;
    return {
      ...source,
      id,
      type,
      label: source.label || source.title || source.name || `${type} ${id}`,
      count: Number(source.example_count ?? source.message_count ?? source.chunk_count ?? source.count ?? 0),
    };
  }

  async function loadSources({ quiet = false } = {}) {
    try {
      if (!quiet) setStatus('Refreshing eligible local conversations…');
      const payload = await request('GET', '/api/training/sources');
      sources = normalizeSources(payload);
      renderSources();
      if (!quiet) setStatus(`${sources.length} eligible conversation source${sources.length === 1 ? '' : 's'} available. Nothing was selected.`);
      return sources;
    } catch (error) {
      if (!quiet) handleError(error, 'Could not refresh training sources');
      return [];
    }
  }

  function sourceKey(source) {
    return `${source.type}:${source.id}`;
  }

  function savedSourceKeys() {
    const refs = current?.sources || current?.source_refs || current?.selected_sources
      || (current?.source_conversations || []).map((id) => ({ type: 'conversation', id }));
    return new Set((Array.isArray(refs) ? refs : []).map((source) => {
      if (typeof source === 'string') return source.includes(':') ? source : `source:${source}`;
      return sourceKey(normalizeSource(source) || { type: 'source', id: '' });
    }));
  }

  function renderSources() {
    const host = byId('ft-source-list');
    if (!host) return;
    if (!sources.length) {
      host.innerHTML = '<div class="ft-empty">No eligible conversations, documents, or imported datasets are available yet.</div>';
      return;
    }
    const selected = savedSourceKeys();
    const locked = Boolean(currentDataset());
    const summary = byId('ft-source-summary');
    if (summary) summary.textContent = selected.size ? `${selected.size} saved source${selected.size === 1 ? '' : 's'}` : 'Nothing selected';
    host.innerHTML = `<div class="ft-source-grid">${sources.map((source, index) => {
      const key = sourceKey(source);
      const checked = Boolean(current?.id && selected.has(key));
      const describedBy = `ft-source-note-${index}`;
      const count = source.count ? `${source.count} candidate item${source.count === 1 ? '' : 's'}` : 'Count available after preparation';
      return `<div class="ft-source-card${checked ? ' selected' : ''}">
        <input id="ft-source-${index}" type="checkbox" name="ft-source" value="${esc(key)}" data-source-type="${esc(source.type)}" data-source-id="${esc(source.id)}" aria-describedby="${describedBy}"${checked ? ' checked' : ''}${locked ? ' disabled' : ''} />
        <label for="ft-source-${index}"><strong>${esc(source.label)}</strong><small id="${describedBy}">${esc(source.type)} · ${esc(count)}</small></label>
        <span class="ft-source-check" aria-hidden="true">${uiIcon('check')}</span>
      </div>`;
    }).join('')}</div>`;
  }

  function selectedSources() {
    const selected = all('input[name="ft-source"]:checked', byId('ft-source-list') || document).map((input) => ({
      type: input.dataset.sourceType || String(input.value).split(':')[0],
      id: input.dataset.sourceId || String(input.value).split(':').slice(1).join(':'),
    }));
    const summary = byId('ft-source-summary');
    if (summary) summary.textContent = selected.length ? `${selected.length} selected source${selected.length === 1 ? '' : 's'}` : 'Nothing selected';
    return selected;
  }

  function consentControls() {
    const known = ['ft-consent-rights', 'ft-consent-sensitive', 'ft-consent-local', 'ft-consent-review']
      .map(byId)
      .filter(Boolean);
    const discovered = all('[data-ft-consent], input[name^="ft-consent"]', byId('ft-step-data') || document);
    return [...new Set([...known, ...discovered])].filter((control) => control.type === 'checkbox');
  }

  function readConsent() {
    const result = {};
    for (const control of consentControls()) {
      const key = control.dataset.ftConsent || control.name || control.id.replace(/^ft-consent-/, '');
      result[key.replace(/^ft-consent-/, '').replace(/-/g, '_')] = Boolean(control.checked);
    }
    return result;
  }

  function fillConsent() {
    const consent = current?.consent || {};
    for (const control of consentControls()) {
      if (document.activeElement === control) continue;
      const key = (control.dataset.ftConsent || control.name || control.id.replace(/^ft-consent-/, ''))
        .replace(/^ft-consent-/, '')
        .replace(/-/g, '_');
      control.checked = Boolean(consent[key]);
    }
    const risk = byId('ft-consent-risk');
    if (risk && document.activeElement !== risk) risk.checked = Boolean(currentDataset()?.consent?.riskAccepted || currentDataset()?.consent?.risk_accepted);
  }

  function validateConsent() {
    const selected = selectedSources();
    if (!selected.length) {
      setStatus('Select at least one data source. SovereignAI never preselects training data.', 'error');
      byId('ft-source-list')?.focus?.();
      return false;
    }
    const controls = consentControls();
    if (!controls.length) {
      setStatus('Consent controls are unavailable. Reload before preparing training data.', 'error');
      return false;
    }
    for (const control of controls) {
      markInvalid(control, !control.checked);
      if (!control.checked) {
        setStatus('Confirm every data-rights and privacy statement before creating the review snapshot.', 'error');
        control.focus();
        return false;
      }
    }
    return true;
  }

  async function prepareExamples() {
    if (!validateConsent()) return;
    // Capture the explicit choices before saveProject re-renders from the
    // persisted project and clears unsaved source/consent controls.
    const sourceRefs = selectedSources();
    const consent = readConsent();
    await runBusy(async () => {
      if (!current?.id || projectDirty) await saveProject({ quiet: true });
      setStatus('Creating a local review snapshot. Original workspace records will not be changed…');
      const payload = await request('POST', `/api/training/projects/${encodeURIComponent(current.id)}/prepare`, {
        sources: sourceRefs,
        conversation_ids: sourceRefs.filter((source) => source.type === 'conversation').map((source) => source.id),
        consent,
      });
      current.sources = sourceRefs;
      current.source_conversations = sourceRefs.filter((source) => source.type === 'conversation').map((source) => source.id);
      current.consent = consent;
      applyPayload(payload, { render: false });
      examples = Array.isArray(payload?.examples) ? payload.examples : examples;
      selectedExampleId = examples[0]?.id || null;
      projectDirty = false;
      exampleDirty = false;
      renderAll();
      goStep(2, { force: true });
      notify(`${examples.length} candidate training example${examples.length === 1 ? '' : 's'} prepared for review.`, { type: 'success' });
      setStatus('Review every included example, remove unsafe content, then lock an immutable dataset.', 'success');
    }).catch((error) => handleError(error, 'Could not prepare training examples'));
  }

  function parseMessages(example) {
    let messages = example?.messages;
    if (typeof messages === 'string') {
      try { messages = JSON.parse(messages); }
      catch { messages = []; }
    }
    if (!Array.isArray(messages)) messages = [];
    const user = messages.find((message) => message?.role === 'user')?.content
      ?? example?.user ?? example?.prompt ?? example?.input ?? example?.user_content ?? '';
    const assistant = [...messages].reverse().find((message) => message?.role === 'assistant')?.content
      ?? example?.assistant ?? example?.response ?? example?.output ?? example?.assistant_content ?? '';
    const system = messages.find((message) => message?.role === 'system')?.content ?? example?.system ?? '';
    return { messages, system: String(system || ''), user: String(user || ''), assistant: String(assistant || '') };
  }

  function exampleFlags(example) {
    const raw = example?.risk_flags || example?.flags || example?.risks || [];
    return (Array.isArray(raw) ? raw : []).map((flag) => {
      if (typeof flag === 'string') {
        const high = /secret|credential|api.?key|password|private.?key|ssn|pii|financial|health/i.test(flag);
        return { label: flag, severity: high ? 'high' : 'warning', resolved: false };
      }
      return {
        ...flag,
        label: flag.label || flag.type || flag.code || 'Risk flag',
        severity: String(flag.severity || flag.level || 'warning').toLowerCase(),
        resolved: Boolean(flag.resolved || flag.acknowledged || example.reviewed),
      };
    });
  }

  function unresolvedHighRisk(example) {
    if (example?.included === false) return false;
    return exampleFlags(example).some((flag) => ['high', 'critical', 'error'].includes(flag.severity) && !flag.resolved);
  }

  function renderExamples() {
    const host = byId('ft-example-list');
    if (!host) return;
    const included = examples.filter((example) => example.included !== false).length;
    const flagged = examples.filter(unresolvedHighRisk).length;
    const count = byId('ft-example-count');
    if (count) count.textContent = `${included} included · ${flagged} unresolved high-risk`;
    const stats = byId('ft-review-stats');
    if (stats) stats.innerHTML = `<span><strong>${examples.length}</strong><small>Prepared</small></span><span><strong>${included}</strong><small>Included</small></span><span class="${flagged ? 'risk' : ''}"><strong>${flagged}</strong><small>High-risk flags</small></span>`;
    if (!examples.length) {
      host.innerHTML = '<div class="ft-empty">Prepare selected sources to generate reviewable examples.</div>';
      renderExampleEditor();
      return;
    }
    if (!selectedExampleId || !examples.some((example) => example.id === selectedExampleId)) selectedExampleId = examples[0].id;
    host.innerHTML = examples.map((example, index) => {
      const content = parseMessages(example);
      const flags = exampleFlags(example);
      const reviewLabel = example.reviewed ? '<em class="reviewed">Reviewed</em>' : '<em class="risk">Needs review</em>';
      return `<button class="ft-example-item${example.id === selectedExampleId ? ' active' : ''}${example.included === false ? ' excluded' : ''}" type="button" data-ft-example-id="${esc(example.id)}" aria-current="${example.id === selectedExampleId ? 'true' : 'false'}">
        <span><strong>Example ${index + 1}</strong><small>${esc(content.user.slice(0, 100) || 'Empty user prompt')}</small></span>
        <span class="ft-example-indicators">${reviewLabel}${example.included === false ? '<em>Excluded</em>' : ''}${flags.length ? `<em class="${unresolvedHighRisk(example) ? 'risk' : ''}">${flags.length} flag${flags.length === 1 ? '' : 's'}</em>` : '<em>Clear</em>'}</span>
      </button>`;
    }).join('');
    renderExampleEditor();
  }

  function selectedExample() {
    return examples.find((example) => example.id === selectedExampleId) || null;
  }

  function renderExampleEditor() {
    const host = byId('ft-example-editor');
    if (!host) return;
    const example = selectedExample();
    if (!example) {
      const id = byId('ft-example-id');
      if (id) id.value = '';
      for (const fieldId of ['ft-example-system', 'ft-example-user', 'ft-example-assistant']) {
        const field = byId(fieldId);
        if (field) field.value = '';
      }
      const included = byId('ft-example-included');
      if (included) included.checked = false;
      const flags = byId('ft-example-flags');
      if (flags) flags.innerHTML = '<span class="ft-panel-empty">Choose an example to inspect it.</span>';
      all('input, textarea, button', host).forEach((control) => { control.disabled = true; });
      return;
    }
    const content = parseMessages(example);
    const flags = exampleFlags(example);
    const locked = Boolean(currentDataset());
    all('input, textarea, button', host).forEach((control) => { control.disabled = locked; });
    const id = byId('ft-example-id');
    if (id) id.value = example.id;
    const included = byId('ft-example-included');
    if (included) included.checked = example.included !== false;
    const system = byId('ft-example-system');
    const user = byId('ft-example-user');
    const assistant = byId('ft-example-assistant');
    if (system) system.value = content.system;
    if (user) user.value = content.user;
    if (assistant) assistant.value = content.assistant;
    const flagHost = byId('ft-example-flags');
    if (flagHost) {
      const provenance = example.provenance?.conversationTitle || example.provenance?.conversation_title || example.source_label || 'Prepared conversation snapshot';
      flagHost.innerHTML = `<span class="ft-provenance">Source: ${esc(provenance)}</span>${flags.length
        ? flags.map((flag) => `<span class="ft-risk ${esc(flag.severity)}">${esc(flag.label)}</span>`).join('')
        : '<span class="ft-clear-note">No automated risk flags · manual review still required</span>'}`;
    }
    const status = byId('ft-example-status');
    if (status) status.textContent = 'Editing this derived copy never changes the source conversation.';
    exampleDirty = false;
  }

  function applySuggestedRedactions() {
    const example = selectedExample();
    if (!example) return;
    const suggestions = example.suggested_redactions || example.redactions || [];
    const user = byId('ft-example-user');
    const assistant = byId('ft-example-assistant');
    let changed = false;
    for (const suggestion of Array.isArray(suggestions) ? suggestions : []) {
      const match = suggestion.match || suggestion.value || suggestion.text;
      if (!match) continue;
      const replacement = suggestion.replacement || `[REDACTED_${String(suggestion.type || 'VALUE').toUpperCase()}]`;
      const target = suggestion.field === 'assistant' || suggestion.role === 'assistant' ? assistant : user;
      if (target?.value.includes(match)) {
        target.value = target.value.split(match).join(replacement);
        changed = true;
      }
    }
    if (changed) {
      exampleDirty = true;
      setStatus('Suggested values were replaced in this derived copy. Inspect the result before saving.');
    } else {
      setStatus('No automatic replacements are available. Review the flagged text manually before acknowledging it.');
      (user || assistant)?.focus();
    }
  }

  async function saveExample() {
    const example = selectedExample();
    if (!example) return null;
    const system = byId('ft-example-system')?.value ?? '';
    const user = byId('ft-example-user')?.value ?? '';
    const assistant = byId('ft-example-assistant')?.value ?? '';
    const included = Boolean(byId('ft-example-included')?.checked);
    if (!user.trim() || !assistant.trim()) {
      setStatus('Every reviewed example needs both a user message and an assistant response, even when excluded.', 'error');
      (!user.trim() ? byId('ft-example-user') : byId('ft-example-assistant'))?.focus();
      return null;
    }
    const messages = [
      ...(system.trim() ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user },
      { role: 'assistant', content: assistant },
    ];
    const payload = {
      system,
      user,
      assistant,
      included,
      state: included ? 'approved' : 'excluded',
      prompt: user,
      response: assistant,
      messages,
    };
    return runBusy(async () => {
      const saved = await request('PUT', `/api/training/examples/${encodeURIComponent(example.id)}`, payload);
      const next = saved?.example || saved;
      examples = examples.map((item) => item.id === example.id ? { ...item, ...next, ...payload } : item);
      exampleDirty = false;
      renderExamples();
      setStatus('Reviewed example saved to the local snapshot.', 'success');
      return next;
    }).catch((error) => {
      handleError(error, 'Could not save reviewed example');
      return null;
    });
  }

  async function chooseExample(id) {
    if (id === selectedExampleId) return;
    if (exampleDirty) {
      const confirmed = await confirmUi({
        title: 'Discard edits to this example?',
        message: 'The current derived example has changes that have not been saved.',
        action: 'Discard edits',
      });
      if (!confirmed) return;
    }
    selectedExampleId = id;
    exampleDirty = false;
    renderExamples();
    byId('ft-example-editor')?.querySelector('h3')?.focus?.({ preventScroll: true });
  }

  async function lockDataset() {
    if (!current?.id) return;
    if (exampleDirty && !(await saveExample())) return;
    const included = examples.filter((example) => example.included !== false);
    if (!included.length) {
      setStatus('Include at least one reviewed example before locking the dataset.', 'error');
      return;
    }
    const unreviewed = included.find((example) => !example.reviewed);
    if (unreviewed) {
      selectedExampleId = unreviewed.id;
      renderExamples();
      setStatus('Open and save every included example before locking the dataset.', 'error');
      byId('ft-example-editor')?.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    const riskConsent = byId('ft-consent-risk');
    if (!riskConsent?.checked) {
      markInvalid(riskConsent, true);
      setStatus('Confirm that you reviewed every included example and accept any remaining automated flags.', 'error');
      riskConsent?.focus();
      return;
    }
    const confirmed = await confirmUi({
      title: 'Lock this training dataset?',
      message: `SovereignAI will freeze ${included.length} reviewed example${included.length === 1 ? '' : 's'} with provenance and consent metadata. Source records remain unchanged.`,
      action: 'Lock dataset',
    });
    if (!confirmed) return;
    await runBusy(async () => {
      setStatus('Freezing the reviewed JSONL dataset…');
      const payload = await request('POST', `/api/training/projects/${encodeURIComponent(current.id)}/datasets`, {
        example_ids: included.map((example) => example.id),
        consent: { ...(current.consent || readConsent()), accepted: true, riskAccepted: true },
      });
      applyPayload(payload, { render: false });
      renderAll();
      goStep(3, { force: true });
      setStatus('Dataset locked. Check the local trainer before submitting the run.', 'success');
      notify('Immutable training dataset created.', { type: 'success' });
    }).catch((error) => handleError(error, 'Could not lock the training dataset'));
  }

  function safeFileName(value, fallback = 'fine-tuning-dataset') {
    const normalized = String(value || '').trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '');
    return normalized || fallback;
  }

  function downloadText(content, filename, type = 'application/jsonl;charset=utf-8') {
    const blob = new Blob([content], { type });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  async function downloadDataset() {
    const dataset = currentDataset();
    const remove = byId('ft-delete-btn');
    if (remove) remove.disabled = busy || !current?.id;
    if (!dataset?.id) {
      setStatus('Lock the reviewed dataset before downloading its JSONL bundle.', 'error');
      return;
    }
    await runBusy(async () => {
      const payload = await request('GET', `/api/training/datasets/${encodeURIComponent(dataset.id)}/export`);
      if (!payload?.manifest || typeof payload.trainJsonl !== 'string' || typeof payload.evalJsonl !== 'string') {
        throw new Error('SovereignAI did not return the complete dataset bundle.');
      }
      const bundle = {
        schema: 'sovereignai.training-export/v1',
        hash: payload.hash,
        manifest: payload.manifest,
        files: {
          'train.jsonl': payload.trainJsonl,
          'eval.jsonl': payload.evalJsonl,
        },
      };
      downloadText(
        `${JSON.stringify(bundle, null, 2)}\n`,
        `${safeFileName(current.title)}.training-dataset.json`,
        'application/json;charset=utf-8'
      );
      setStatus('Portable manifest, train split, and evaluation split downloaded.', 'success');
    }).catch((error) => handleError(error, 'Could not download the dataset'));
  }

  function trainerEndpoint() {
    const input = byId('ft-trainer-url') || byId('ft-trainer-endpoint');
    return input?.value?.trim() || capabilities?.endpoint || capabilities?.base_url || capabilities?.url || 'configured local trainer';
  }

  function endpointMode(endpoint) {
    try {
      const host = new URL(endpoint).hostname.toLowerCase().replace(/\.$/, '');
      const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
      return local ? 'local' : 'self-hosted';
    } catch { return 'configured'; }
  }

  function trainerConfig() {
    const numberValue = (id, fallback) => {
      const value = Number(byId(id)?.value);
      return Number.isFinite(value) ? value : fallback;
    };
    const method = byId('ft-method')?.value || 'sft-qlora';
    return {
      endpoint: trainerEndpoint(),
      method,
      base_model: projectFormValue().base_model,
      hyperparameters: {
        epochs: numberValue('ft-epochs', 3),
        learningRate: numberValue('ft-learning-rate', 0.0002),
        maxSequenceLength: numberValue('ft-sequence-length', 2048),
        loraRank: numberValue('ft-lora-rank', 16),
        loraAlpha: numberValue('ft-lora-alpha', 32),
        seed: numberValue('ft-seed', 42),
      },
    };
  }

  function fillTrainerConfig() {
    const config = app().state?.config?.training || {};
    const values = {
      'ft-trainer-url': config.baseUrl || '',
      'ft-trainer-token': config.authToken || '',
    };
    for (const [id, value] of Object.entries(values)) {
      const control = byId(id);
      if (control && document.activeElement !== control) control.value = value;
    }
    if (byId('ft-trainer-enabled')) byId('ft-trainer-enabled').checked = Boolean(config.enabled);
    if (byId('ft-trainer-remote')) byId('ft-trainer-remote').checked = Boolean(config.allowRemote);
    if (byId('ft-trainer-insecure')) byId('ft-trainer-insecure').checked = Boolean(config.allowInsecurePrivateNetwork);
    const destination = byId('ft-data-destination');
    if (destination) destination.textContent = config.baseUrl
      ? `The complete approved snapshot will go to ${config.baseUrl}.`
      : 'No trainer endpoint configured.';
  }

  async function saveTrainerConfig() {
    const baseUrl = byId('ft-trainer-url')?.value?.trim() || '';
    if (!baseUrl) {
      setStatus('Enter the URL of your local or self-hosted trainer.', 'error');
      byId('ft-trainer-url')?.focus();
      return null;
    }
    const update = {
      enabled: Boolean(byId('ft-trainer-enabled')?.checked),
      baseUrl,
      authToken: byId('ft-trainer-token')?.value || '',
      allowRemote: Boolean(byId('ft-trainer-remote')?.checked),
      allowInsecurePrivateNetwork: Boolean(byId('ft-trainer-insecure')?.checked),
    };
    return runBusy(async () => {
      const saved = await request('PUT', '/api/config', { training: update });
      if (app().state) app().state.config = { ...(app().state.config || {}), training: saved.training || update };
      capabilities = null;
      fillTrainerConfig();
      setStatus('Trainer configuration saved locally.', 'success');
      notify('Local trainer settings saved.', { type: 'success' });
      return saved;
    }).catch((error) => {
      handleError(error, 'Could not save trainer configuration');
      return null;
    });
  }

  function renderCapabilities() {
    const health = byId('ft-trainer-health') || byId('ft-trainer-status');
    const endpoint = trainerEndpoint();
    const mode = endpointMode(endpoint);
    const available = Boolean(capabilities?.available ?? capabilities?.ok ?? capabilities?.configured);
    if (health) {
      health.className = `runtime-badge ${available ? 'ok' : 'bad'}`;
      health.dataset.mode = mode;
      health.textContent = available ? 'Trainer ready' : 'Trainer not ready';
    }
    const runtimeBadge = byId('ft-runtime-badge');
    if (runtimeBadge) {
      runtimeBadge.className = `runtime-badge ${available ? 'ok' : 'bad'}`;
      runtimeBadge.textContent = available ? 'Trainer ready' : 'Trainer unavailable';
    }
    const details = byId('ft-capabilities');
    if (details) {
      const supported = capabilities?.methods || capabilities?.training_methods || capabilities?.models || [];
      const devices = Array.isArray(capabilities?.hardware?.devices) ? capabilities.hardware.devices : [];
      const gib = (bytes) => Number.isFinite(bytes) ? `${(bytes / (1024 ** 3)).toFixed(1)} GiB` : '';
      const facts = [
        capabilities?.runner?.name ? `Runner: ${capabilities.runner.name}${capabilities.runner.version ? ` ${capabilities.runner.version}` : ''}` : '',
        devices.length ? `Accelerator: ${devices.map((device) => device.name || device.backend).filter(Boolean).join(', ')}` : '',
        gib(capabilities?.hardware?.freeDiskBytes) ? `Free disk: ${gib(capabilities.hardware.freeDiskBytes)}` : '',
        Array.isArray(capabilities?.outputs) && capabilities.outputs.length ? `Outputs: ${capabilities.outputs.join(', ')}` : '',
        Number.isFinite(capabilities?.limits?.maxSequenceLength) ? `Max sequence: ${capabilities.limits.maxSequenceLength}` : '',
      ].filter(Boolean);
      details.innerHTML = `<div class="ft-capability-row"><span><strong>${available ? 'Capabilities verified' : 'Trainer needs attention'}</strong><small>${esc(endpoint)} · ${esc(mode)}</small></span><span>${esc(capabilities?.detail || capabilities?.message || '')}</span></div>${facts.length ? `<div class="ft-capability-facts">${facts.map((fact) => `<span>${esc(fact)}</span>`).join('')}</div>` : ''}${Array.isArray(supported) && supported.length ? `<div class="ft-capability-chips">${supported.slice(0, 20).map((item) => `<span>${esc(typeof item === 'string' ? item : item.label || item.id || item.name || 'supported')}</span>`).join('')}</div>` : ''}`;
    }
    const disclosure = byId('ft-trainer-disclosure');
    if (disclosure) {
      disclosure.dataset.mode = mode;
      disclosure.textContent = mode === 'local'
        ? 'The full locked dataset is submitted to a loopback trainer on this machine.'
        : `The full locked dataset is sent to your self-hosted trainer at ${endpoint}. This is more data than chat retrieval sends.`;
    }
    const urlInput = byId('ft-trainer-url') || byId('ft-trainer-endpoint');
    if (urlInput && !urlInput.value && endpoint !== 'configured local trainer') urlInput.value = endpoint;
    const methodSelect = byId('ft-method') || byId('ft-trainer-method') || byId('ft-training-method');
    const methods = capabilities?.methods || capabilities?.training_methods;
    if (methodSelect?.tagName === 'SELECT' && Array.isArray(methods) && methods.length) {
      const previous = methodSelect.value;
      methodSelect.innerHTML = methods.map((item) => {
        const value = typeof item === 'string' ? item : item.id || item.value;
        const label = typeof item === 'string' ? item : item.label || value;
        return `<option value="${esc(value)}">${esc(label)}</option>`;
      }).join('');
      if ([...methodSelect.options].some((option) => option.value === previous)) methodSelect.value = previous;
    }
  }

  async function loadCapabilities({ quiet = false } = {}) {
    try {
      if (!quiet) setStatus('Checking the configured local trainer…');
      capabilities = await request('GET', '/api/training/capabilities');
      renderCapabilities();
      if (!quiet) setStatus(capabilities?.available ?? capabilities?.ok ? 'Local trainer is ready.' : 'The local trainer needs attention.', capabilities?.available ?? capabilities?.ok ? 'success' : 'error');
      return capabilities;
    } catch (error) {
      capabilities = { available: false, detail: errorMessage(error) };
      renderCapabilities();
      if (!quiet) handleError(error, 'Trainer health check failed');
      return capabilities;
    }
  }

  async function saveAndCheckTrainer() {
    const saved = await saveTrainerConfig();
    if (saved) await loadCapabilities();
  }

  async function startTraining() {
    const dataset = currentDataset();
    if (!dataset?.id) {
      setStatus('Lock a reviewed dataset before starting training.', 'error');
      return;
    }
    if (Number(dataset.eval_count) < 1) {
      setStatus('This snapshot has no independent holdout. Create a new project with at least two conversation groups before training.', 'error');
      return;
    }
    if (!(capabilities?.available ?? capabilities?.ok ?? capabilities?.configured)) await loadCapabilities({ quiet: true });
    if (!(capabilities?.available ?? capabilities?.ok ?? capabilities?.configured)) {
      setStatus('The configured local/self-hosted trainer is not ready.', 'error');
      return;
    }
    const config = trainerConfig();
    const mode = endpointMode(config.endpoint);
    const confirmed = await confirmUi({
      title: 'Start this training run?',
      message: mode === 'local'
        ? `The locked dataset will be submitted to the loopback trainer at ${config.endpoint}. Training may use substantial compute and disk space.`
        : `The full locked dataset will leave this machine for your self-hosted trainer at ${config.endpoint}. Training may use substantial compute and disk space.`,
      action: 'Start training',
    });
    if (!confirmed) return;
    await runBusy(async () => {
      setStatus(`Submitting the locked dataset to ${config.endpoint}…`);
      const payload = await request('POST', `/api/training/datasets/${encodeURIComponent(dataset.id)}/runs`, {
        trainer: { endpoint: config.endpoint },
        method: config.method,
        base_model: config.base_model,
        hyperparameters: config.hyperparameters,
        consent: {
          accepted: true,
          datasetHash: dataset.hash,
          trainerEndpoint: config.endpoint,
        },
      });
      applyPayload(payload, { render: false });
      renderAll();
      goStep(3, { force: true });
      schedulePoll();
      notify('Local training run submitted.', { type: 'success' });
    }).catch((error) => handleError(error, 'Could not start local training'));
  }

  function renderRun() {
    const run = currentRun();
    const host = byId('ft-run-summary') || byId('ft-run-status') || byId('ft-training-status');
    if (!host) return;
    if (!run) {
      const dataset = currentDataset();
      host.innerHTML = dataset?.eval_count === 0
        ? '<strong>This snapshot is export-only.</strong><p>Actual training needs at least two independent conversation groups so one can remain an untouched holdout.</p>'
        : '<strong>No training run yet.</strong><p>Approve a dataset and verify the trainer before starting.</p>';
      const progressBar = byId('ft-progress-bar');
      if (progressBar) progressBar.style.width = '0%';
      return;
    }
    const status = runState(run) || 'unknown';
    const rawProgress = Number(run.progress ?? run.percent ?? run.progress_percent);
    const progress = Number.isFinite(rawProgress) ? Math.max(0, Math.min(100, rawProgress <= 1 ? rawProgress * 100 : rawProgress)) : null;
    const detail = run.detail || run.message || run.stage || 'Waiting for trainer status';
    host.innerHTML = `<div class="ft-run-title"><span class="ft-badge ${COMPLETE_RUN_STATES.has(status) ? 'success' : ACTIVE_RUN_STATES.has(status) ? 'active' : status === 'failed' ? 'error' : ''}">${esc(status.replace(/[_-]+/g, ' '))}</span><strong>${esc(detail)}</strong></div>
      <p>${progress === null ? 'Progress is reported by the trainer.' : `${Math.round(progress)}% complete.`} Run ${esc(run.id || '')}${run.updated_at ? ` · updated ${esc(dateLabel(run.updated_at))}` : ''}</p>${run.error ? `<p class="ft-run-error">${esc(run.error)}</p>` : ''}`;
    const progressBar = byId('ft-progress-bar');
    if (progressBar) {
      progressBar.style.width = `${progress ?? 0}%`;
      const progressHost = progressBar.parentElement;
      progressHost?.setAttribute('role', progress === null ? 'status' : 'progressbar');
      if (progress !== null) {
        progressHost.setAttribute('aria-valuemin', '0');
        progressHost.setAttribute('aria-valuemax', '100');
        progressHost.setAttribute('aria-valuenow', String(Math.round(progress)));
      } else {
        progressHost?.removeAttribute('aria-valuenow');
      }
      progressHost?.removeAttribute('aria-hidden');
    }
    const log = byId('ft-run-log');
    if (log) {
      const lines = Array.isArray(run.logs) ? run.logs : run.log ? String(run.log).split('\n') : [];
      log.textContent = lines.slice(-200).join('\n');
    }
  }

  function stopPolling() {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  function schedulePoll(delay = 3000) {
    stopPolling();
    if (!currentRun()?.id || !ACTIVE_RUN_STATES.has(runState())) return;
    const projectId = current?.id;
    const runId = currentRun()?.id;
    pollTimer = setTimeout(async () => {
      if (current?.id !== projectId || currentRun()?.id !== runId) return;
      await refreshRun({ quiet: true, expectedProjectId: projectId, expectedRunId: runId });
      if (current?.id === projectId && ACTIVE_RUN_STATES.has(runState())) schedulePoll();
    }, delay);
  }

  async function refreshRun({ quiet = false, expectedProjectId = null, expectedRunId = null } = {}) {
    const run = currentRun();
    if (!run?.id) return null;
    if ((expectedProjectId && current?.id !== expectedProjectId) || (expectedRunId && run.id !== expectedRunId)) return null;
    try {
      const previous = runState(run);
      const payload = await request('POST', `/api/training/runs/${encodeURIComponent(run.id)}/refresh`, {});
      if ((expectedProjectId && current?.id !== expectedProjectId) || (expectedRunId && currentRun()?.id !== expectedRunId)) return null;
      applyPayload(payload, { render: false });
      renderAll();
      const next = runState();
      if (!quiet || previous !== next) setStatus(`Training run: ${next.replace(/[_-]+/g, ' ')}.`, COMPLETE_RUN_STATES.has(next) ? 'success' : next === 'failed' ? 'error' : '');
      if (COMPLETE_RUN_STATES.has(next)) notify('Training completed. Evaluate the tuned model against its base.', { type: 'success' });
      return currentRun();
    } catch (error) {
      if ((!expectedProjectId || current?.id === expectedProjectId) && (!expectedRunId || currentRun()?.id === expectedRunId)) {
        const active = currentRun();
        if (active?.id === run.id) {
          active.status = 'unreachable';
          active.stage = 'Trainer status unavailable';
          active.error = errorMessage(error);
          renderRun();
          syncActions();
        }
        if (!quiet) handleError(error, 'Could not refresh training status');
        else setStatus('Trainer status is unavailable. Use Refresh to retry the same run.', 'error');
      }
      return null;
    }
  }

  async function cancelRun() {
    const run = currentRun();
    if (!run?.id || !BLOCKING_RUN_STATES.has(runState(run))) return;
    const confirmed = await confirmUi({
      title: 'Cancel this training run?',
      message: 'SovereignAI will ask the configured trainer to stop. Partial checkpoints may remain until you clean them up.',
      action: 'Cancel run',
    });
    if (!confirmed) return;
    await runBusy(async () => {
      stopPolling();
      const payload = await request('POST', `/api/training/runs/${encodeURIComponent(run.id)}/cancel`, {});
      applyPayload(payload);
      setStatus('Cancellation requested. Refresh status to confirm the trainer stopped.');
    }).catch((error) => handleError(error, 'Could not cancel the training run'));
  }

  function renderEvaluation() {
    const evaluation = currentEvaluation();
    const results = byId('ft-metrics') || byId('ft-eval-results');
    if (results) {
      if (!evaluation) {
        results.innerHTML = '<div class="ft-empty">Trainer-reported frozen-holdout evidence appears after training completes. Deployment remains locked until you record a decision.</div>';
      } else {
        const metrics = evaluation.metrics && typeof evaluation.metrics === 'object' ? Object.entries(evaluation.metrics) : [];
        const comparisons = Array.isArray(evaluation.comparisons) ? evaluation.comparisons : [];
        results.innerHTML = `${metrics.length ? `<div class="ft-metric-grid">${metrics.map(([name, value]) => `<div><span>${esc(String(name).replace(/[_-]+/g, ' '))}</span><strong>${esc(typeof value === 'number' ? Number(value).toFixed(3).replace(/0+$/, '').replace(/\.$/, '') : value)}</strong></div>`).join('')}</div>` : ''}
          ${comparisons.length ? `<div class="ft-comparison-list">${comparisons.slice(0, 20).map((comparison, index) => `<article><strong>Holdout ${index + 1}</strong><p>${esc(comparison.prompt || comparison.input || '')}</p><div><section><small>Base</small><p>${esc(comparison.base || comparison.baseline || '')}</p></section><section><small>Tuned</small><p>${esc(comparison.tuned || comparison.candidate || '')}</p></section></div></article>`).join('')}</div>` : `<p class="ft-eval-summary">${esc(evaluation.summary || evaluation.detail || 'Evaluation completed. Review the metrics and record your deployment decision.')}</p>`}`;
      }
    }
    const decision = evaluationDecision(evaluation);
    const decisionSelect = byId('ft-eval-decision');
    if (decisionSelect?.tagName === 'SELECT') decisionSelect.value = decision || '';
    for (const input of all('input[name="ft-eval-decision"]')) input.checked = false;
    const radio = all('input[name="ft-eval-decision"]').find((input) => input.value === decision);
    if (radio) radio.checked = true;
    const notes = byId('ft-eval-notes');
    if (notes && document.activeElement !== notes) notes.value = evaluation?.notes || '';
    const status = byId('ft-eval-status');
    if (status) status.textContent = decision
      ? `Decision saved: ${decision.replace(/[_-]+/g, ' ')}.`
      : 'Deployment remains locked until you record a decision.';
  }

  function selectedDecision() {
    return document.querySelector('input[name="ft-eval-decision"]:checked')?.value
      || byId('ft-eval-decision')?.value
      || '';
  }

  async function evaluateRun() {
    const run = currentRun();
    if (!run?.id || !COMPLETE_RUN_STATES.has(runState(run))) {
      setStatus('Training must complete before evaluating the frozen holdout set.', 'error');
      return;
    }
    await runBusy(async () => {
      setStatus('Loading frozen-holdout evidence reported by the trainer…');
      const payload = await request('POST', `/api/training/runs/${encodeURIComponent(run.id)}/evaluate`, { action: 'evaluate' });
      applyPayload(payload, { render: false });
      renderAll();
      goStep(4, { force: true });
      setStatus('Trainer evidence loaded. Inspect metrics and test representative prompts before recording a decision.', 'success');
    }).catch((error) => handleError(error, 'Could not evaluate the tuned model'));
  }

  async function saveEvaluation() {
    const run = currentRun();
    if (!run?.id) return null;
    const decision = selectedDecision();
    if (!decision) {
      setStatus('Choose whether to approve, reject, or retrain before saving the evaluation.', 'error');
      byId('ft-eval-decision')?.focus();
      return null;
    }
    if (decision === 'approved' && currentEvaluation()?.evidence === false) {
      setStatus('Approval requires evaluation-specific holdout metrics from the trainer. Reject the run or document an explicit skip.', 'error');
      return null;
    }
    const notes = byId('ft-eval-notes')?.value?.trim() || '';
    if (decision === 'skipped' && !notes) {
      setStatus('Explain why behavioral evaluation is being skipped before deployment.', 'error');
      byId('ft-eval-notes')?.focus();
      return null;
    }
    return runBusy(async () => {
      const payload = await request('POST', `/api/training/runs/${encodeURIComponent(run.id)}/evaluate`, { decision, notes });
      applyPayload(payload, { render: false });
      current.evaluation = { ...(current.evaluation || {}), decision, notes };
      renderAll();
      const deployable = DEPLOYABLE_DECISIONS.has(decision);
      setStatus(deployable ? 'Evaluation gate satisfied. Review the trainer-attested artifact before assignment.' : 'Evaluation decision saved. Deployment remains locked.', deployable ? 'success' : '');
      return current.evaluation;
    }).catch((error) => {
      handleError(error, 'Could not save the evaluation decision');
      return null;
    });
  }

  function ollamaEndpoint() {
    let endpoint = app().state?.config?.providers?.ollama?.baseUrl || 'configured Ollama endpoint';
    try {
      const url = new URL(endpoint);
      url.username = '';
      url.password = '';
      endpoint = url.toString().replace(/\/$/, '');
    } catch { /* Keep the generic label for incomplete settings. */ }
    return endpoint;
  }

  function artifactModel(artifact = currentRun()?.artifact || currentDeployment()?.artifact) {
    if (!artifact) return '';
    if (typeof artifact === 'string') return artifact;
    return artifact.ollama_model || artifact.ollamaModel || artifact.model || artifact.name || artifact.ref || '';
  }

  function renderDeployment() {
    populatePersonas();
    const model = byId('ft-deploy-model');
    const artifact = currentRun()?.artifact || currentDeployment()?.artifact || null;
    const verifiedModel = artifactModel(artifact);
    if (model) {
      if (document.activeElement !== model) model.value = verifiedModel;
      model.readOnly = true;
    }
    const disclosure = byId('ft-deploy-disclosure');
    if (disclosure) {
      const endpoint = ollamaEndpoint();
      disclosure.textContent = `The trainer already registered this model at ${endpoint}. SovereignAI verifies the reported tag and digest, then assigns it to the persona; the training dataset is not sent to Ollama.`;
    }
    const artifactHost = byId('ft-artifact');
    if (artifactHost) artifactHost.innerHTML = artifact
      ? `<div class="ft-artifact-summary"><span class="ft-badge ${artifact.verified === false ? 'error' : 'success'}">${artifact.verified === false ? 'Unverified' : 'Trainer attested'}</span><div><strong>${esc(verifiedModel || 'Artifact returned without an Ollama model name')}</strong><p>${esc(typeof artifact === 'object' ? artifact.detail || artifact.format || artifact.path || 'Trainer-produced model artifact' : 'Trainer-produced model artifact')}</p></div></div>`
      : '<div class="ft-panel-empty">A trainer-attested artifact appears after training succeeds.</div>';
    const status = byId('ft-deploy-status');
    if (status) status.textContent = deploymentComplete()
      ? `Assigned ${verifiedModel || 'the tuned model'} to the selected persona.`
      : verifiedModel ? 'Choose a persona; deployment will verify its Ollama digest before assignment.' : 'Waiting for an Ollama artifact attestation from the trainer.';
  }

  async function deployRun() {
    const run = currentRun();
    if (!run?.id) return;
    if (!DEPLOYABLE_DECISIONS.has(evaluationDecision())) {
      setStatus('Approve the evaluation before deploying the tuned model.', 'error');
      goStep(4, { force: true });
      return;
    }
    const model = byId('ft-deploy-model')?.value?.trim() || artifactModel();
    const personaId = byId('ft-deploy-persona')?.value || null;
    if (!model) {
      setStatus('The trainer has not returned a verified Ollama artifact name.', 'error');
      byId('ft-deploy-model')?.focus();
      return;
    }
    if (!personaId) {
      setStatus('Choose the persona that should use this tuned model.', 'error');
      byId('ft-deploy-persona')?.focus();
      return;
    }
    const endpoint = ollamaEndpoint();
    const confirmed = await confirmUi({
      title: 'Deploy this tuned model?',
      message: `SovereignAI will verify the trainer-registered model “${model}” at ${endpoint}, then assign it to the selected persona. The locked training dataset is not included.`,
      action: 'Deploy model',
    });
    if (!confirmed) return;
    await runBusy(async () => {
      setStatus(`Verifying “${model}” at ${endpoint}…`);
      const payload = await request('POST', `/api/training/runs/${encodeURIComponent(run.id)}/deploy`, {
        model,
        persona_id: personaId,
      });
      applyPayload(payload, { render: false });
      current.deployment = payload?.deployment || current.deployment || { status: 'deployed', model, persona_id: personaId };
      renderAll();
      setStatus(`“${model}” is ready at ${endpoint}.`, 'success');
      notify(`Tuned model ${model} deployed.`, { type: 'success' });
    }).catch((error) => handleError(error, 'Model deployment failed'));
  }

  function renderStepNav() {
    const host = byId('ft-step-nav');
    if (!host) return;
    const available = highestAvailableStep();
    host.innerHTML = STEP_LABELS.map((label, index) => {
      const active = index === step;
      const complete = index < available;
      return `<li><button class="ft-step-button${active ? ' active' : ''}${complete ? ' complete' : ''}" type="button" data-ft-step="${STEP_KEYS[index]}"${active ? ' aria-current="step"' : ''}${index > available ? ' disabled' : ''}>
        <span>${complete ? uiIcon('check') : index + 1}</span><span><small>Step ${index + 1}</small><strong>${esc(label)}</strong></span>
      </button></li>`;
    }).join('');
  }

  function showStepPanels() {
    STEP_IDS.forEach((id, index) => {
      const panel = byId(id);
      if (!panel) return;
      const active = index === step;
      panel.hidden = !active;
      panel.setAttribute('aria-hidden', String(!active));
      if ('inert' in panel) panel.inert = !active;
    });
  }

  function syncActions() {
    const back = byId('ft-back');
    const next = byId('ft-next');
    if (back) {
      back.hidden = step === 0;
      back.disabled = busy;
    }
    if (!next) return;
    const run = currentRun();
    const labels = [
      current?.id && !projectDirty ? 'Choose data' : 'Save & choose data',
      examples.length ? 'Review examples' : 'Prepare examples',
      currentDataset() ? 'Continue to training' : 'Lock reviewed dataset',
      COMPLETE_RUN_STATES.has(runState(run)) ? 'Evaluate results' : 'Training must finish',
      DEPLOYABLE_DECISIONS.has(evaluationDecision()) ? 'Continue to deployment' : 'Record a deployment decision',
      'Deployment complete',
    ];
    next.textContent = labels[step];
    next.hidden = step === 5;
    next.disabled = busy || (step === 3 && !COMPLETE_RUN_STATES.has(runState(run)));

    const dataset = currentDataset();
    const download = byId('ft-download-btn');
    if (download) download.disabled = busy || !dataset?.id;
    const lock = byId('ft-lock-btn');
    if (lock) lock.disabled = busy || !examples.length || Boolean(dataset);
    const start = byId('ft-train-btn') || byId('ft-start-btn');
    if (start) start.disabled = busy || !dataset?.id || Number(dataset.eval_count) < 1 || BLOCKING_RUN_STATES.has(runState(run)) || COMPLETE_RUN_STATES.has(runState(run));
    const refresh = byId('ft-refresh-run') || byId('ft-run-refresh-btn') || byId('ft-refresh-btn');
    if (refresh) refresh.disabled = busy || !run?.id;
    const cancel = byId('ft-run-cancel-btn') || byId('ft-cancel-btn');
    if (cancel) cancel.disabled = busy || !run?.id || !BLOCKING_RUN_STATES.has(runState(run));
    const deploy = byId('ft-deploy-btn');
    if (deploy) deploy.disabled = busy || !run?.id || !DEPLOYABLE_DECISIONS.has(evaluationDecision()) || deploymentComplete();
  }

  function renderAll() {
    const projectHeading = byId('ft-project-heading');
    if (projectHeading && current) projectHeading.textContent = current.title || 'New fine-tuning project';
    renderProjects();
    renderStepNav();
    showStepPanels();
    renderSources();
    fillConsent();
    renderExamples();
    fillTrainerConfig();
    renderCapabilities();
    renderRun();
    renderEvaluation();
    renderDeployment();
    syncActions();
  }

  function goStep(next, { force = false, focus = true } = {}) {
    const available = highestAvailableStep();
    step = Math.max(0, Math.min(5, force ? next : Math.min(next, available)));
    renderStepNav();
    showStepPanels();
    syncActions();
    if (step === 3) {
      renderCapabilities();
      renderRun();
    }
    if (step === 4) renderEvaluation();
    if (step === 5) renderDeployment();
    if (focus) {
      requestAnimationFrame(() => {
        const heading = byId(STEP_IDS[step])?.querySelector('h2, h3');
        if (!heading) return;
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      });
    }
  }

  async function nextStep() {
    if (busy) return;
    if (step === 0) {
      try {
        await runBusy(() => saveProject({ quiet: true }));
        goStep(1, { force: true });
        setStatus('Select only the data you have the right to use. Nothing is selected automatically.');
      } catch (error) { handleError(error, 'Could not save the training goal'); }
      return;
    }
    if (step === 1) {
      if (examples.length && !projectDirty) goStep(2, { force: true });
      else await prepareExamples();
      return;
    }
    if (step === 2) {
      if (currentDataset()) goStep(3, { force: true });
      else await lockDataset();
      return;
    }
    if (step === 3) {
      if (COMPLETE_RUN_STATES.has(runState())) goStep(4, { force: true });
      else setStatus('Wait for training to complete, or refresh its status.', 'error');
      return;
    }
    if (step === 4) {
      const evaluation = await saveEvaluation();
      if (evaluation && DEPLOYABLE_DECISIONS.has(evaluationDecision(evaluation))) goStep(5, { force: true });
    }
  }

  function bindClick(id, handler) {
    const control = byId(id);
    if (!control || control.dataset.ftBound === 'true') return;
    control.dataset.ftBound = 'true';
    control.addEventListener('click', handler);
  }

  function bindControls() {
    bindClick('ft-new-btn', newProject);
    for (const control of all('[data-ft-new]')) {
      if (control.dataset.ftBound === 'true') continue;
      control.dataset.ftBound = 'true';
      control.addEventListener('click', newProject);
    }
    bindClick('ft-delete-btn', () => current?.id && deleteProject(current.id));
    bindClick('ft-refresh-sources', () => loadSources());
    bindClick('ft-prepare-btn', prepareExamples);
    bindClick('ft-lock-btn', lockDataset);
    bindClick('ft-download-btn', downloadDataset);
    bindClick('ft-trainer-save', saveTrainerConfig);
    bindClick('ft-trainer-check', saveAndCheckTrainer);
    bindClick('ft-trainer-check-btn', saveAndCheckTrainer);
    bindClick('ft-trainer-refresh-btn', () => loadCapabilities());
    bindClick('ft-train-btn', startTraining);
    bindClick('ft-start-btn', startTraining);
    bindClick('ft-run-refresh-btn', () => refreshRun());
    bindClick('ft-refresh-run', () => refreshRun());
    bindClick('ft-refresh-btn', () => refreshRun());
    bindClick('ft-run-cancel-btn', cancelRun);
    bindClick('ft-cancel-btn', cancelRun);
    bindClick('ft-evaluate-btn', evaluateRun);
    bindClick('ft-eval-save', saveEvaluation);
    bindClick('ft-deploy-btn', deployRun);
    bindClick('ft-back', () => goStep(step - 1, { force: true }));
    bindClick('ft-next', nextStep);

    const projectList = byId('ft-project-list');
    if (projectList && projectList.dataset.ftBound !== 'true') {
      projectList.dataset.ftBound = 'true';
      projectList.addEventListener('click', (event) => {
        const open = event.target.closest('[data-ft-project-id]');
        const remove = event.target.closest('[data-ft-project-delete]');
        if (remove) deleteProject(remove.dataset.ftProjectDelete);
        else if (open) openProject(open.dataset.ftProjectId);
      });
    }

    const nav = byId('ft-step-nav');
    if (nav && nav.dataset.ftBound !== 'true') {
      nav.dataset.ftBound = 'true';
      nav.addEventListener('click', (event) => {
        const button = event.target.closest('[data-ft-step]');
        const index = STEP_KEYS.indexOf(button?.dataset.ftStep);
        if (button && !button.disabled && index >= 0) goStep(index);
      });
    }

    const form = byId('ft-project-form');
    if (form && form.dataset.ftBound !== 'true') {
      form.dataset.ftBound = 'true';
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        nextStep();
      });
      form.addEventListener('input', (event) => {
        event.target.removeAttribute?.('aria-invalid');
        setDirty(true);
      });
      form.addEventListener('change', () => setDirty(true));
    }

    const sourceList = byId('ft-source-list');
    if (sourceList && sourceList.dataset.ftBound !== 'true') {
      sourceList.dataset.ftBound = 'true';
      sourceList.addEventListener('change', (event) => {
        if (!event.target.matches('input[name="ft-source"]')) return;
        event.target.closest('.ft-source-card')?.classList.toggle('selected', event.target.checked);
        setDirty(true);
      });
    }

    const dataStep = byId('ft-step-data');
    if (dataStep && dataStep.dataset.ftConsentBound !== 'true') {
      dataStep.dataset.ftConsentBound = 'true';
      dataStep.addEventListener('change', (event) => {
        if (!consentControls().includes(event.target)) return;
        event.target.removeAttribute('aria-invalid');
        setDirty(true);
      });
    }

    const exampleList = byId('ft-example-list');
    if (exampleList && exampleList.dataset.ftBound !== 'true') {
      exampleList.dataset.ftBound = 'true';
      exampleList.addEventListener('click', (event) => {
        const button = event.target.closest('[data-ft-example-id]');
        if (button) chooseExample(button.dataset.ftExampleId);
      });
    }

    const editor = byId('ft-example-editor');
    if (editor && editor.dataset.ftBound !== 'true') {
      editor.dataset.ftBound = 'true';
      editor.addEventListener('submit', (event) => {
        event.preventDefault();
        saveExample();
      });
      editor.addEventListener('input', (event) => {
        if (event.target.matches('textarea, input')) exampleDirty = true;
      });
      editor.addEventListener('change', (event) => {
        if (event.target.matches('textarea, input')) exampleDirty = true;
      });
      editor.addEventListener('click', (event) => {
        if (event.target.closest('#ft-example-redact')) applySuggestedRedactions();
      });
    }

    for (const button of all('[data-ft-action]')) {
      if (button.dataset.ftActionBound === 'true') continue;
      const actions = {
        prepare: prepareExamples,
        lock: lockDataset,
        download: downloadDataset,
        'check-trainer': () => loadCapabilities(),
        train: startTraining,
        refresh: () => refreshRun(),
        cancel: cancelRun,
        evaluate: evaluateRun,
        'save-evaluation': saveEvaluation,
        deploy: deployRun,
      };
      const handler = actions[button.dataset.ftAction];
      if (!handler) continue;
      button.dataset.ftActionBound = 'true';
      button.addEventListener('click', handler);
    }
  }

  function initialize() {
    if (initialized) {
      bindControls();
      return Boolean(byId('view-finetune'));
    }
    if (!byId('view-finetune')) return false;
    initialized = true;
    bindControls();
    showFlow(false);
    renderProjects();
    populatePersonas();
    fillTrainerConfig();
    return true;
  }

  async function load(options = {}) {
    if (!initialize()) return [];
    const force = Boolean(options?.force);
    if (loaded && !force) {
      if (!isDirty()) renderAll();
      if (ACTIVE_RUN_STATES.has(runState())) schedulePoll();
      return projects;
    }
    if (loadPromise && !force) return loadPromise;
    loadPromise = (async () => {
      setStatus('Loading local fine-tuning projects and trainer capabilities…');
      const [projectResult, sourceResult, capabilityResult] = await Promise.allSettled([
        request('GET', '/api/training/projects'),
        request('GET', '/api/training/sources'),
        request('GET', '/api/training/capabilities'),
      ]);
      if (projectResult.status === 'fulfilled') {
        const value = unwrap(projectResult.value, 'projects');
        projects = Array.isArray(value) ? value.map(projectSummary) : [];
      } else {
        handleError(projectResult.reason, 'Could not load fine-tuning projects');
      }
      if (sourceResult.status === 'fulfilled') sources = normalizeSources(sourceResult.value);
      else sources = [];
      if (capabilityResult.status === 'fulfilled') capabilities = capabilityResult.value;
      else capabilities = { available: false, detail: errorMessage(capabilityResult.reason) };
      loaded = true;
      renderAll();
      setStatus(projectResult.status === 'fulfilled'
        ? 'Fine-tuning projects are stored locally. Select one or start a new guided run.'
        : 'Fine-tuning Studio loaded with limited local data.', projectResult.status === 'fulfilled' ? '' : 'error');
      return projects;
    })().finally(() => { loadPromise = null; });
    return loadPromise;
  }

  window.addEventListener('beforeunload', (event) => {
    if (!isDirty()) return;
    event.preventDefault();
    event.returnValue = '';
  });

  window.SOVEREIGN_FINE_TUNE = { load, isDirty };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
