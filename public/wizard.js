/* SovereignAI first-run wizard: name → brain → personality → data → create. */
(function () {
  const $ = (selector) => document.querySelector(selector);
  const wizard = $('#wizard');
  if (!wizard) return;

  const steps = [...wizard.querySelectorAll('.wz-step')];
  const STEPS = steps.length || 5;
  const SETUP_PERSONA_DESCRIPTION = 'Created by the setup wizard';
  // FreeToken first: an engine already serving on this machine is the best
  // default we can offer, and it is the only entry that appears conditionally.
  const PROVIDERS = ['freetoken', 'ollama', 'anthropic', 'openai'];
  const originalDisabledState = new WeakMap();

  let step = 0;
  const state = {
    bootComplete: false,
    bootInFlight: false,
    bootTimer: null,
    opened: false,
    navigating: false,
    traits: new Set(),
    uploads: 0,
    pendingUploads: 0,
    uploadQueue: Promise.resolve(),
    ollamaHint: 'Checking whether the configured Ollama endpoint is available…',
    // Set only when a FreeToken engine actually answers on this machine.
    freetokenHint: '',
    baked: null,
    config: null,
  };

  async function api(method, path, body, { timeoutMs = 0 } = {}) {
    const auth = typeof SOVEREIGN_HEADERS === 'function' ? SOVEREIGN_HEADERS() : {};
    const headers = { ...auth };
    if (body !== undefined) headers['content-type'] = 'application/json';

    const controller = timeoutMs ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let res;
    try {
      res = await fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller?.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw new Error(`Request timed out while contacting ${path}.`);
      throw new Error(`Could not contact SovereignAI at ${path}: ${errorMessage(err)}`);
    } finally {
      if (timer) clearTimeout(timer);
    }

    const raw = await res.text();
    let payload = null;
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = null;
      }
    }
    if (!res.ok) {
      const detail = payload?.error || raw.trim() || res.statusText || 'Unknown server error';
      throw new Error(`${detail} (${res.status})`);
    }
    if (raw && payload === null) throw new Error(`SovereignAI returned an invalid response for ${path}.`);
    return payload ?? {};
  }

  function errorMessage(err) {
    if (err instanceof Error && err.message) return err.message;
    if (typeof err === 'string' && err) return err;
    return 'Unexpected error';
  }

  function setError(message = '') {
    const activeStep = steps[step];
    let error = step === STEPS - 1 ? $('#wz-error') : activeStep?.querySelector('.wz-step-error');
    if (message && !error && activeStep) {
      error = document.createElement('p');
      error.className = 'form-error wz-step-error';
      activeStep.appendChild(error);
    }
    wizard.querySelectorAll('.wz-step-error, #wz-error').forEach((element) => {
      if (element !== error || !message) element.textContent = '';
    });
    if (!error) return;
    error.setAttribute('role', 'alert');
    error.setAttribute('aria-live', 'assertive');
    error.textContent = message;
  }

  function markInvalid(control, invalid) {
    if (!control) return;
    if (invalid) control.setAttribute('aria-invalid', 'true');
    else control.removeAttribute('aria-invalid');
  }

  // ---- boot: wait for the API instead of permanently missing setup during warm-up ----
  async function boot(attempt = 0) {
    if (state.bootComplete || state.bootInFlight) return;
    state.bootInFlight = true;
    try {
      const [status, config] = await Promise.all([
        api('GET', '/api/status', undefined, { timeoutMs: 5000 }),
        api('GET', '/api/config', undefined, { timeoutMs: 5000 }),
      ]);
      state.config = config;
      state.bootComplete = true;
      if (!status.setupComplete) open();
    } catch (err) {
      // Retry quickly during startup, then continue polling at a low rate. The page and
      // API share a server, so opening setup without a status result risks duplicating it.
      const retryMs = Math.min(500 * (2 ** attempt), 5000);
      clearTimeout(state.bootTimer);
      state.bootTimer = setTimeout(() => boot(Math.min(attempt + 1, 4)), retryMs);
      console.warn(`Setup status unavailable; retrying in ${retryMs}ms.`, err);
    } finally {
      state.bootInFlight = false;
    }
  }

  window.addEventListener('online', () => {
    if (!state.bootComplete) {
      clearTimeout(state.bootTimer);
      boot(0);
    }
  });
  boot();

  function open() {
    if (state.opened) return;
    state.opened = true;
    wizard.classList.remove('hidden');
    wizard.setAttribute('role', 'dialog');
    wizard.setAttribute('aria-modal', 'true');
    document.body.classList.add('wizard-open');
    updateProviderUi();
    show(0, { focus: false });
    const heading = steps[0]?.querySelector('h1, h2, h3');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
    for (const background of document.querySelectorAll('#main, #sidebar, .skip-link')) {
      background.setAttribute('aria-hidden', 'true');
      if ('inert' in background) background.inert = true;
    }
    probeProviders();
  }

  function stepTitle(index) {
    return steps[index]?.querySelector('h1, h2, h3')?.textContent?.trim() || `Setup step ${index + 1}`;
  }

  function renderProgress() {
    const progress = $('#wz-progress');
    if (!progress) return;
    progress.replaceChildren();
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-label', 'Setup progress');
    progress.setAttribute('aria-valuemin', '1');
    progress.setAttribute('aria-valuemax', String(STEPS));
    progress.setAttribute('aria-valuenow', String(step + 1));
    progress.setAttribute('aria-valuetext', `Step ${step + 1} of ${STEPS}: ${stepTitle(step)}`);

    for (let index = 0; index < STEPS; index++) {
      const marker = document.createElement('span');
      marker.classList.toggle('done', index <= step);
      marker.classList.toggle('current', index === step);
      marker.setAttribute('aria-hidden', 'true');
      progress.appendChild(marker);
    }
  }

  function show(nextStep, { focus = true } = {}) {
    step = Math.max(0, Math.min(nextStep, STEPS - 1));
    steps.forEach((element, index) => {
      const active = index === step;
      element.classList.toggle('active', active);
      element.hidden = !active;
      element.setAttribute('aria-hidden', String(!active));
      if ('inert' in element) element.inert = !active;

      const heading = element.querySelector('h1, h2, h3');
      if (heading && !heading.id) heading.id = `wz-step-title-${index}`;
    });

    const heading = steps[step]?.querySelector('h1, h2, h3');
    if (heading) wizard.setAttribute('aria-labelledby', heading.id);

    const back = $('#wz-back');
    if (back) {
      back.hidden = step === 0;
      back.setAttribute('aria-hidden', String(step === 0));
    }
    const next = $('#wz-next');
    if (next) next.textContent = step === STEPS - 1 ? '⬡ Create my AI' : 'Continue';

    const stepLabel = $('#wz-step-label');
    if (stepLabel) stepLabel.textContent = `Step ${step + 1} of ${STEPS}`;

    renderProgress();
    if (step === STEPS - 1) renderSummary();
    setError('');

    if (focus) {
      requestAnimationFrame(() => {
        const activeHeading = steps[step]?.querySelector('h1, h2, h3');
        if (!activeHeading) return;
        activeHeading.tabIndex = -1;
        activeHeading.focus({ preventScroll: true });
      });
    }
  }

  // Keep keyboard focus inside the modal wizard.
  wizard.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || wizard.classList.contains('hidden')) return;
    const focusable = [...wizard.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter((element) => !element.hidden && !element.closest('[hidden]'));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!focusable.includes(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  // ---- provider selection and probing ----
  function selectedProvider() {
    return document.querySelector('input[name="wz-provider"]:checked')?.value || '';
  }

  function selectedModel(provider = selectedProvider()) {
    // FreeToken serves one model per process: the choice was made by whoever
    // ran "ft serve", so the wizard reports it rather than offering a list.
    if (provider === 'freetoken') return $('#wz-freetoken-model')?.dataset?.model?.trim() || '';
    if (provider === 'ollama') return $('#wz-ollama-model')?.value?.trim() || '';
    if (provider === 'openai') return $('#wz-openai-model')?.value?.trim() || '';
    return $('#wz-anthropic-model')?.value?.trim() || '';
  }

  function isLoopbackEndpoint(rawUrl) {
    try {
      const hostname = new URL(rawUrl).hostname.toLowerCase();
      return hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || hostname === '0.0.0.0' || hostname.startsWith('127.');
    } catch {
      return false;
    }
  }

  function providerProfile(provider = selectedProvider()) {
    if (provider === 'ollama') {
      const endpoint = state.config?.providers?.ollama?.baseUrl || 'http://localhost:11434';
      const local = isLoopbackEndpoint(endpoint);
      const profile = {
        mode: 'local',
        label: 'Local · Ollama',
        providerLabel: 'Ollama',
        disclosure: 'Chats are sent only to your configured Ollama endpoint. SovereignAI stores conversations, memory, and documents locally; no Anthropic or OpenAI-compatible chat service is used.',
        system: 'Runtime context: responses are generated through the user’s configured Ollama endpoint. Do not make unverified claims about that endpoint’s network location.',
      };
      if (!local) {
        profile.mode = 'remote';
        profile.label = 'Configured endpoint / Ollama';
        profile.disclosure = 'Prompts and any relevant memory or document excerpts are sent to the configured Ollama endpoint. Its network location, privacy, and retention depend on whoever operates that endpoint.';
      }
      return profile;
    }
    if (provider === 'freetoken') {
      return {
        mode: 'local',
        label: 'Local · FreeToken',
        providerLabel: 'FreeToken',
        disclosure: 'Chats are sent to the FreeToken engine running on this machine, over loopback. SovereignAI stores conversations, memory, and documents locally; no remote chat service is used. FreeToken itself requires no authentication, so anything else running as you on this machine can reach it too.',
        system: 'Runtime context: responses are generated by a FreeToken engine on the user’s own machine. Do not make unverified claims about which model it is serving.',
      };
    }
    if (provider === 'anthropic') {
      return {
        mode: 'remote',
        label: 'Remote · Anthropic',
        providerLabel: 'Anthropic',
        disclosure: 'When you chat, prompts and any relevant memory or document excerpts are sent to Anthropic. SovereignAI still stores its local data on this machine.',
        system: 'Runtime context: responses are generated by Anthropic using the user’s API credentials. Do not claim that model inference or chat content stays entirely on this device.',
      };
    }
    if (provider === 'openai') {
      const endpoint = $('#wz-openai-url')?.value?.trim() || '';
      const local = isLoopbackEndpoint(endpoint);
      return {
        mode: local ? 'local' : 'remote',
        label: local ? 'Local endpoint · OpenAI-compatible' : 'Configured endpoint · OpenAI-compatible',
        providerLabel: 'OpenAI-compatible',
        disclosure: local
          ? 'Chats are sent to the OpenAI-compatible service running at this device’s loopback address. SovereignAI stores conversations, memory, and documents locally.'
          : 'When you chat, prompts and any relevant memory or document excerpts are sent to the configured endpoint. Its privacy and retention policy depend on whoever operates that endpoint.',
        system: 'Runtime context: responses are generated through the user’s configured OpenAI-compatible endpoint. Do not claim that the endpoint is self-hosted or that chat content stays entirely on this device unless the user confirms its current deployment.',
      };
    }
    return {
      mode: 'unknown',
      label: 'Choose a provider',
      providerLabel: 'No provider selected',
      disclosure: 'Choose a provider to see where chat content will be processed.',
      system: 'Be transparent about uncertainty regarding the model runtime.',
    };
  }

  function setProviderGroupEnabled(group, enabled) {
    group.hidden = !enabled;
    group.setAttribute('aria-hidden', String(!enabled));
    for (const control of group.querySelectorAll('input, select, textarea, button')) {
      if (control.matches('input[name="wz-provider"]')) continue;
      if (!originalDisabledState.has(control)) originalDisabledState.set(control, control.disabled);
      control.disabled = enabled ? originalDisabledState.get(control) : true;
    }
  }

  function providerGroups() {
    const groups = new Set(document.querySelectorAll('[data-wz-provider-fields], [data-provider-fields]'));
    for (const provider of PROVIDERS) {
      const byId = $(`#wz-${provider}-fields`);
      if (byId) groups.add(byId);
    }
    return [...groups];
  }

  function updateProviderHint(profile) {
    const hint = $('#wz-provider-hint');
    if (!hint) return;
    hint.setAttribute('aria-live', 'polite');
    hint.dataset.mode = profile.mode;
    const provider = selectedProvider();
    const copy = provider === 'ollama' ? state.ollamaHint : provider === 'freetoken' && state.freetokenHint ? state.freetokenHint : profile.disclosure;
    if (hint.textContent !== copy) hint.textContent = copy;
  }

  function updateProviderUi() {
    const provider = selectedProvider();
    const profile = providerProfile(provider);
    const groups = providerGroups();

    for (const group of groups) {
      const groupProvider = group.dataset.wzProviderFields || group.dataset.providerFields || PROVIDERS.find((id) => group.id === `wz-${id}-fields`);
      if (groupProvider) setProviderGroupEnabled(group, groupProvider === provider);
    }

    // Backward-compatible fallback when the markup has not wrapped provider fields yet.
    if (!groups.length) {
      const controls = {
        ollama: [$('#wz-ollama-model')],
        anthropic: [$('#wz-anthropic-key'), $('#wz-anthropic-model')],
        openai: [$('#wz-openai-url'), $('#wz-openai-key'), $('#wz-openai-model')],
      };
      for (const [id, fields] of Object.entries(controls)) {
        for (const field of fields.filter(Boolean)) {
          if (!originalDisabledState.has(field)) originalDisabledState.set(field, field.disabled);
          field.hidden = id !== provider;
          field.disabled = id === provider ? originalDisabledState.get(field) : true;
        }
      }
    }

    for (const radio of document.querySelectorAll('input[name="wz-provider"]')) {
      const selected = radio.checked;
      radio.closest('.wz-choice')?.classList.toggle('selected', selected);
    }

    const disclosure = $('#wz-provider-disclosure');
    if (disclosure) {
      if (disclosure.textContent !== profile.disclosure) disclosure.textContent = profile.disclosure;
      disclosure.dataset.mode = profile.mode;
      disclosure.setAttribute('role', 'note');
    }
    const privacyNote = $('#wz-privacy-note');
    if (privacyNote) {
      const copy = privacyNote.querySelector('span') || privacyNote;
      if (copy.textContent !== profile.disclosure) copy.textContent = profile.disclosure;
      privacyNote.dataset.mode = profile.mode;
      privacyNote.classList.toggle('local', profile.mode === 'local');
      privacyNote.classList.toggle('remote', profile.mode === 'remote');
      privacyNote.setAttribute('role', 'note');
    }
    const endpointChoice = document.querySelector(`input[name="wz-provider"][value="${provider}"]`)?.closest('.wz-choice');
    const endpointBadge = endpointChoice?.querySelector('.choice-badge');
    if (endpointBadge && (provider === 'openai' || provider === 'ollama')) {
      endpointBadge.textContent = profile.mode === 'local' ? 'Local' : 'Endpoint';
      endpointBadge.classList.toggle('local', profile.mode === 'local');
      endpointBadge.classList.toggle('remote', profile.mode !== 'local');
    }
    for (const item of document.querySelectorAll('[data-wz-provider-disclosure]')) {
      const itemProvider = item.dataset.wzProviderDisclosure;
      if (!itemProvider) continue;
      item.hidden = itemProvider !== provider;
      item.setAttribute('aria-hidden', String(itemProvider !== provider));
    }

    updateProviderHint(profile);
    updateBakeVisibility();
    if (step === STEPS - 1) renderSummary();
  }

  document.querySelectorAll('input[name="wz-provider"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      setError('');
      updateProviderUi();
    });
  });
  $('#wz-openai-url')?.addEventListener('input', () => updateProviderUi());

  /**
   * A FreeToken engine can be serving on this machine while its provider is
   * still switched off, in which case /api/providers says nothing about it —
   * it only health-checks providers that are already enabled. Someone who ran
   * `ft serve` before opening SovereignAI should meet their own engine here,
   * not discover it in Settings after finishing setup.
   *
   * The choice is revealed only when one actually answers, and pre-selected
   * only when it is ready and Ollama is not — a running local engine is a
   * better default than an endpoint with no models, and never a reason to
   * override a working Ollama the person may have set up on purpose.
   */
  async function probeFreeToken({ ollamaReady }) {
    const choice = $('#wz-choice-freetoken');
    const radio = $('#wz-provider-freetoken');
    if (!choice || !radio) return;
    let found = null;
    try {
      const res = await api('GET', '/api/providers/freetoken/detect', undefined, { timeoutMs: 6000 });
      // A positive signal only. `{ running: false }` is the no answer, but so
      // is any partial body — an empty object must never become a phantom
      // engine offering a blank model.
      if (res && typeof res.ready === 'boolean' && typeof res.url === 'string') found = res;
    } catch {
      found = null; // nothing running, or the probe failed: either way, offer nothing
    }
    const modelLine = $('#wz-freetoken-model');
    if (!found) {
      choice.hidden = true;
      radio.disabled = true;
      if (radio.checked) {
        radio.checked = false;
        const fallback = $('#wz-provider-ollama');
        if (fallback) fallback.checked = true;
      }
      return;
    }
    choice.hidden = false;
    // Not ready is still worth showing: "still loading, 42%" is a wait, and a
    // person who knows their engine is coming up will wait for it.
    radio.disabled = !found.ready;
    if (modelLine) {
      modelLine.textContent = found.model || 'Not reported by the engine';
      modelLine.dataset.model = found.model || '';
    }
    state.freetokenHint = found.ready
      ? `${found.detail} — on this machine, over loopback.`
      : `${found.detail} Setup can continue with another provider; FreeToken can be switched on later in Settings.`;
    if (found.ready && found.model && !ollamaReady) radio.checked = true;
  }

  async function probeProviders() {
    const modelSelect = $('#wz-ollama-model');
    if (modelSelect) modelSelect.setAttribute('aria-busy', 'true');
    let ollamaReady = false;
    try {
      const providers = await api('GET', '/api/providers', undefined, { timeoutMs: 12000 });
      if (!Array.isArray(providers)) throw new Error('Provider status was not a list.');
      const ollama = providers.find((provider) => provider.id === 'ollama');
      if (ollama?.ok) {
        ollamaReady = true;
        state.ollamaHint = `Ollama is ready: ${ollama.detail || 'configured endpoint detected'}.`;
        try {
          const response = await api('GET', '/api/models?provider=ollama', undefined, { timeoutMs: 15000 });
          const models = Array.isArray(response.models) ? response.models : [];
          populateOllamaModels(models);
          if (!models.length) state.ollamaHint = 'Ollama is running, but it has no chat models yet. Pull a model first, or choose another provider.';
        } catch (err) {
          populateOllamaModels([]);
          state.ollamaHint = `Ollama was detected, but its models could not be listed: ${errorMessage(err)}`;
        }
      } else {
        populateOllamaModels([]);
        state.ollamaHint = 'Ollama is not ready. Start Ollama and pull a model, or choose a configured remote provider.';
      }
    } catch (err) {
      populateOllamaModels([]);
      state.ollamaHint = `Provider status could not be checked: ${errorMessage(err)} Check the service, reload, or configure another provider.`;
    } finally {
      if (modelSelect) modelSelect.removeAttribute('aria-busy');
      // After Ollama, so a working Ollama keeps the default it already had.
      await probeFreeToken({ ollamaReady });
      updateProviderUi();
    }
  }

  function populateOllamaModels(models) {
    const select = $('#wz-ollama-model');
    if (!select) return;
    const previous = select.value;
    const options = [];
    if (models.length) {
      for (const model of models) {
        const id = String(model?.id ?? '').trim();
        if (!id) continue;
        const option = document.createElement('option');
        option.value = id;
        option.textContent = String(model?.label || id);
        options.push(option);
      }
    }
    if (!options.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No Ollama chat models available';
      options.push(option);
    }
    select.replaceChildren(...options);
    if ([...select.options].some((option) => option.value === previous)) select.value = previous;
  }

  // ---- personality traits ----
  document.querySelectorAll('#wz-traits button').forEach((button) => {
    if (!button.hasAttribute('type')) button.type = 'button';
    const enabled = button.classList.contains('on');
    button.setAttribute('aria-pressed', String(enabled));
    if (enabled && button.dataset.trait) state.traits.add(button.dataset.trait);
    button.addEventListener('click', (event) => {
      event.preventDefault();
      const on = !button.classList.contains('on');
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', String(on));
      const trait = button.dataset.trait;
      if (!trait) return;
      if (on) state.traits.add(trait);
      else state.traits.delete(trait);
    });
  });

  // ---- file drop ----
  const drop = $('#wz-drop');
  const fileInput = $('#wz-files');
  const fileList = $('#wz-file-list');
  if (fileList) {
    fileList.setAttribute('aria-live', 'polite');
    fileList.setAttribute('aria-relevant', 'additions text');
  }
  if (drop && fileInput) {
    drop.setAttribute('role', 'button');
    if (!drop.hasAttribute('tabindex')) drop.tabIndex = 0;
    if (!drop.hasAttribute('aria-label')) drop.setAttribute('aria-label', 'Choose documents to add to the knowledge base');
    drop.addEventListener('click', () => fileInput.click());
    if (drop.tagName !== 'BUTTON') {
      drop.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        fileInput.click();
      });
    }
    drop.addEventListener('dragover', (event) => {
      event.preventDefault();
      drop.classList.add('over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (event) => {
      event.preventDefault();
      drop.classList.remove('over');
      queueFiles(event.dataTransfer?.files);
    });
    fileInput.addEventListener('change', (event) => queueFiles(event.target.files));
  }

  function queueFiles(files) {
    const queued = Array.from(files || []);
    if (!queued.length) return;
    state.pendingUploads += queued.length;
    updateUploadBusy();
    state.uploadQueue = state.uploadQueue.then(() => uploadFiles(queued));
  }

  function updateUploadBusy() {
    if (!drop) return;
    drop.setAttribute('aria-busy', String(state.pendingUploads > 0));
  }

  async function uploadFiles(files) {
    for (const file of files) {
      const item = document.createElement('li');
      item.textContent = `Uploading ${file.name}…`;
      fileList?.appendChild(item);
      try {
        if (typeof filePayload !== 'function') throw new Error('The document uploader is not available. Reload and try again.');
        const payload = await filePayload(file);
        const doc = await api('POST', '/api/documents', payload);
        item.textContent = `Added ${file.name} (${doc.chunk_count} chunks)`;
        item.className = 'ok';
        state.uploads++;
      } catch (err) {
        item.textContent = `Could not add ${file.name}: ${errorMessage(err)}`;
        item.className = 'err';
      } finally {
        state.pendingUploads = Math.max(0, state.pendingUploads - 1);
        updateUploadBusy();
      }
    }
    if (fileInput) fileInput.value = '';
  }

  // ---- final summary ----
  function renderSummary() {
    const summary = $('#wz-summary');
    if (!summary) return;
    const name = $('#wz-name')?.value?.trim() || 'Your AI';
    const provider = selectedProvider();
    const profile = providerProfile(provider);
    const model = selectedModel(provider) || (provider === 'anthropic' ? 'Claude (provider default)' : 'No model selected');
    const autoMemory = Boolean($('#wz-auto-memory')?.checked);
    const knowledge = state.uploads
      ? `${state.uploads} document${state.uploads === 1 ? '' : 's'} ready`
      : 'No documents yet — you can add them later';

    summary.setAttribute('aria-live', 'polite');
    summary.innerHTML = `
      <dl class="wz-summary-list">
        <div><dt>Assistant</dt><dd><strong>${esc(name)}</strong></dd></div>
        <div><dt>Runtime</dt><dd><strong>${esc(profile.label)}</strong> · ${esc(model)}</dd></div>
        <div><dt>Knowledge</dt><dd>${esc(knowledge)}</dd></div>
        <div><dt>Automatic memory</dt><dd>${autoMemory ? 'On — durable facts may be learned after chats' : 'Off — you can turn it on later'}</dd></div>
      </dl>
      <p class="wz-privacy-disclosure ${esc(profile.mode)}">${esc(profile.disclosure)}</p>`;

    const bakeName = $('#wz-bake-name');
    if (bakeName) bakeName.textContent = name;
    updateBakeVisibility();
  }

  function updateBakeVisibility() {
    const bakeRow = $('#wz-bake-row');
    if (!bakeRow) return;
    const visible = selectedProvider() === 'ollama' && Boolean(selectedModel('ollama'));
    bakeRow.hidden = !visible;
    bakeRow.setAttribute('aria-hidden', String(!visible));
  }

  // ---- navigation and validation ----
  $('#wz-back')?.addEventListener('click', () => {
    if (!state.navigating) show(step - 1);
  });

  $('#wz-next')?.addEventListener('click', async () => {
    if (state.navigating) return;
    setError('');

    if (step === 0 && !$('#wz-name')?.value?.trim()) {
      setError('Enter a name for your AI to continue.');
      markInvalid($('#wz-name'), true);
      $('#wz-name')?.focus();
      return;
    }
    markInvalid($('#wz-name'), false);

    if (step === 1 && !validateProvider()) return;

    if (step === 3 && state.pendingUploads > 0) {
      state.navigating = true;
      const next = $('#wz-next');
      if (next) {
        next.disabled = true;
        next.textContent = 'Finishing uploads…';
      }
      await state.uploadQueue;
      state.navigating = false;
      if (next) next.disabled = false;
    }

    if (step < STEPS - 1) {
      show(step + 1);
      return;
    }
    await finish();
  });

  $('#wz-name')?.addEventListener('input', () => markInvalid($('#wz-name'), false));
  for (const selector of ['#wz-ollama-model', '#wz-anthropic-key', '#wz-openai-url', '#wz-openai-model']) {
    $(selector)?.addEventListener('input', (event) => markInvalid(event.currentTarget, false));
    $(selector)?.addEventListener('change', (event) => markInvalid(event.currentTarget, false));
  }

  function validateProvider() {
    const provider = selectedProvider();
    for (const selector of ['#wz-ollama-model', '#wz-anthropic-key', '#wz-openai-url', '#wz-openai-model']) {
      markInvalid($(selector), false);
    }

    if (!provider) {
      setError('Choose where your AI should run.');
      document.querySelector('input[name="wz-provider"]')?.focus();
      return false;
    }
    // FreeToken's model is whatever `ft serve` was started with — nothing here
    // can fix a blank one, so the honest instruction points at the engine.
    if (provider === 'freetoken' && !selectedModel('freetoken')) {
      setError('FreeToken did not report which model it is serving. Check "ft ctl health", or choose another provider.');
      $('#wz-provider-freetoken')?.focus();
      return false;
    }
    if (provider === 'ollama' && !selectedModel('ollama')) {
      setError('Choose an Ollama chat model. If none are available, pull one in Ollama or select another provider.');
      markInvalid($('#wz-ollama-model'), true);
      $('#wz-ollama-model')?.focus();
      return false;
    }
    if (provider === 'anthropic' && !$('#wz-anthropic-key')?.value?.trim()) {
      setError('Enter an Anthropic API key to use Claude.');
      markInvalid($('#wz-anthropic-key'), true);
      $('#wz-anthropic-key')?.focus();
      return false;
    }
    if (provider === 'openai') {
      const urlInput = $('#wz-openai-url');
      const rawUrl = urlInput?.value?.trim() || '';
      if (!rawUrl) {
        setError('Enter the base URL for your OpenAI-compatible endpoint.');
        markInvalid(urlInput, true);
        urlInput?.focus();
        return false;
      }
      try {
        const url = new URL(rawUrl);
        if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error('Invalid endpoint');
      } catch {
        setError('Enter a complete OpenAI-compatible base URL beginning with http:// or https://.');
        markInvalid(urlInput, true);
        urlInput?.focus();
        return false;
      }
      const modelInput = $('#wz-openai-model');
      if (!modelInput?.value?.trim()) {
        setError('Enter the exact model ID exposed by your OpenAI-compatible endpoint.');
        markInvalid(modelInput, true);
        modelInput?.focus();
        return false;
      }
    }
    return true;
  }

  function buildSystemPrompt(name, provider) {
    const description = $('#wz-personality')?.value?.trim();
    const profile = providerProfile(provider);
    const parts = [
      `You are ${name}, the user’s personal AI assistant.`,
      profile.system,
      'Respect the user’s agency and privacy. Be transparent about uncertainty, limitations, and where data is processed.',
    ];
    if (description) parts.push(`Your character, in the user’s words: ${description}`);
    if (state.traits.size) parts.push([...state.traits].join(' '));
    parts.push('Be genuinely useful. When you are unsure, say so plainly.');
    return parts.join('\n');
  }

  async function upsertSetupPersona(payload) {
    const personas = await api('GET', '/api/personas');
    if (!Array.isArray(personas)) throw new Error('Could not read the existing persona list.');
    const setupPersonas = personas.filter((persona) => persona.description === SETUP_PERSONA_DESCRIPTION);
    const existing = setupPersonas.find((persona) => persona.name?.trim().toLowerCase() === payload.name.trim().toLowerCase())
      || setupPersonas.sort((a, b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at)))[0];
    return existing
      ? api('PUT', `/api/personas/${encodeURIComponent(existing.id)}`, payload)
      : api('POST', '/api/personas', payload);
  }

  function normalizeBaseUrl(rawUrl) {
    return rawUrl.trim().replace(/\/+$/, '');
  }

  function shouldBake(provider, model) {
    return provider === 'ollama' && Boolean(model) && Boolean($('#wz-bake')?.checked) && !$('#wz-bake-row')?.hidden;
  }

  async function finish() {
    const name = $('#wz-name')?.value?.trim() || '';
    if (!name) {
      show(0);
      setError('Enter a name for your AI before creating it.');
      markInvalid($('#wz-name'), true);
      $('#wz-name')?.focus();
      return;
    }
    if (!validateProvider()) {
      show(1, { focus: false });
      validateProvider();
      return;
    }

    const next = $('#wz-next');
    const back = $('#wz-back');
    const provider = selectedProvider();
    let model = selectedModel(provider);
    const system = buildSystemPrompt(name, provider);
    state.navigating = true;
    wizard.setAttribute('aria-busy', 'true');
    if (next) {
      next.disabled = true;
      next.textContent = 'Creating…';
    }
    if (back) back.disabled = true;
    setError('');

    try {
      if (shouldBake(provider, model)) {
        if (next) next.textContent = 'Baking your Ollama model…';
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'my-ai';
        const bakeKey = JSON.stringify({ slug, base: model, system });
        if (state.baked?.key === bakeKey) {
          model = state.baked.model;
        } else {
          const baked = await api('POST', '/api/create-model', { name: slug, base: model, system });
          if (!baked.model) throw new Error('Ollama did not return the new model name.');
          model = baked.model;
          state.baked = { key: bakeKey, model };
        }
      }

      if (next) next.textContent = 'Saving your assistant…';
      const providersUpdate = {};
      if (provider === 'ollama') providersUpdate.ollama = { enabled: true };
      // The detected engine's URL is already in config (loopback by default);
      // finishing setup only has to switch the provider on.
      if (provider === 'freetoken') providersUpdate.freetoken = { enabled: true };
      if (provider === 'anthropic') {
        providersUpdate.anthropic = { enabled: true, apiKey: $('#wz-anthropic-key').value.trim() };
      }
      if (provider === 'openai') {
        providersUpdate.openai = {
          enabled: true,
          baseUrl: normalizeBaseUrl($('#wz-openai-url').value),
          apiKey: $('#wz-openai-key')?.value?.trim() || '',
        };
      }

      const persona = await upsertSetupPersona({
        name,
        description: SETUP_PERSONA_DESCRIPTION,
        system_prompt: system,
        provider,
        model: model || null,
        use_memory: true,
        use_knowledge: true,
      });
      if (!persona?.id) throw new Error('The assistant was saved without an ID. Please try again.');

      if (next) next.textContent = 'Finishing setup…';
      await api('PUT', '/api/config', {
        name,
        providers: providersUpdate,
        defaults: { provider, model, personaId: persona.id },
        memory: { autoExtract: Boolean($('#wz-auto-memory')?.checked) },
        setupComplete: true,
      });

      state.bootComplete = true;
      location.reload();
    } catch (err) {
      setError(`Setup was not completed: ${errorMessage(err)}`);
      state.navigating = false;
      wizard.removeAttribute('aria-busy');
      if (next) {
        next.disabled = false;
        next.textContent = '⬡ Create my AI';
      }
      if (back) back.disabled = false;
    }
  }

  function esc(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
})();
