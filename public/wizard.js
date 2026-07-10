/* SovereignAI first-run wizard: name → brain → personality → data → create. */
(function () {
  const $ = (sel) => document.querySelector(sel);
  const wizard = $('#wizard');
  const STEPS = 5;
  let step = 0;
  const state = { traits: [], uploads: 0 };

  async function api(method, path, body) {
    const auth = typeof SOVEREIGN_HEADERS === 'function' ? SOVEREIGN_HEADERS() : {};
    const res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', ...auth },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
    return res.json();
  }

  // ---- boot: show only on first run ----
  (async () => {
    try {
      const status = await api('GET', '/api/status');
      if (!status.setupComplete) open();
    } catch { /* server warming up */ }
  })();

  function open() {
    wizard.classList.remove('hidden');
    renderProgress();
    show(0);
    probeProviders();
  }

  function renderProgress() {
    $('#wz-progress').innerHTML = Array.from({ length: STEPS }, (_, i) => `<span class="${i <= step ? 'done' : ''}"></span>`).join('');
  }

  function show(n) {
    step = n;
    document.querySelectorAll('.wz-step').forEach((el) => el.classList.toggle('active', Number(el.dataset.step) === n));
    $('#wz-back').style.visibility = n === 0 ? 'hidden' : 'visible';
    $('#wz-next').textContent = n === STEPS - 1 ? '⬡ Create my AI' : 'Next';
    renderProgress();
    if (n === 4) renderSummary();
  }

  // ---- step 1: provider probing ----
  async function probeProviders() {
    try {
      const providers = await api('GET', '/api/providers');
      const ollama = providers.find((p) => p.id === 'ollama');
      if (ollama?.ok) {
        $('#wz-provider-hint').textContent = `Found ${ollama.detail} on this machine — fully local is ready to go.`;
        const { models } = await api('GET', '/api/models?provider=ollama');
        $('#wz-ollama-model').innerHTML = models.length
          ? models.map((m) => `<option value="${m.id}">${m.id}</option>`).join('')
          : '<option value="">No models yet — run: ollama pull llama3.1</option>';
      } else {
        $('#wz-provider-hint').textContent = 'Ollama not detected. Install it from ollama.com for a fully local AI, or use an API key below.';
        $('#wz-ollama-model').innerHTML = '<option value="">Ollama not running</option>';
      }
    } catch {
      $('#wz-provider-hint').textContent = 'Could not check providers — you can still configure one below.';
    }
  }

  // ---- step 2: trait chips ----
  document.querySelectorAll('#wz-traits button').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      btn.classList.toggle('on');
      const trait = btn.dataset.trait;
      state.traits = btn.classList.contains('on') ? [...state.traits, trait] : state.traits.filter((t) => t !== trait);
    })
  );

  // ---- step 3: file drop ----
  const drop = $('#wz-drop');
  const fileInput = $('#wz-files');
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    uploadFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', (e) => uploadFiles(e.target.files));

  async function uploadFiles(files) {
    for (const file of files) {
      const li = document.createElement('li');
      li.textContent = `⏳ ${file.name}`;
      $('#wz-file-list').appendChild(li);
      try {
        const payload = await filePayload(file);
        const doc = await api('POST', '/api/documents', payload);
        li.textContent = `✓ ${file.name} (${doc.chunk_count} chunks)`;
        li.className = 'ok';
        state.uploads++;
      } catch (err) {
        li.textContent = `✕ ${file.name}: ${err.message}`;
        li.className = 'err';
      }
    }
    fileInput.value = '';
  }

  // ---- step 4: summary ----
  function renderSummary() {
    const name = $('#wz-name').value.trim() || 'Your AI';
    const provider = document.querySelector('input[name="wz-provider"]:checked').value;
    const model = provider === 'ollama' ? $('#wz-ollama-model').value : provider === 'anthropic' ? 'Claude' : 'your endpoint';
    $('#wz-summary').innerHTML =
      `<strong>${esc(name)}</strong> will run on <strong>${esc(model || 'a model you pick later')}</strong> (${provider === 'ollama' ? 'fully local' : provider}), ` +
      `remember what you tell it${$('#wz-auto-memory').checked ? ', learn about you automatically' : ''}, ` +
      (state.uploads > 0 ? `and answer from the <strong>${state.uploads} document${state.uploads > 1 ? 's' : ''}</strong> you added. ` : `and build a knowledge base as you add documents. `) +
      `Everything stays on this machine.`;
    $('#wz-bake-name').textContent = name;
    $('#wz-bake-row').style.display = provider === 'ollama' && $('#wz-ollama-model').value ? 'flex' : 'none';
  }

  // ---- navigation ----
  $('#wz-back').addEventListener('click', () => show(Math.max(0, step - 1)));
  $('#wz-next').addEventListener('click', async () => {
    $('#wz-error').textContent = '';
    if (step === 0 && !$('#wz-name').value.trim()) {
      $('#wz-name').focus();
      return;
    }
    if (step === 1 && !validateProvider()) return;
    if (step < STEPS - 1) {
      show(step + 1);
      return;
    }
    await finish();
  });

  function validateProvider() {
    const provider = document.querySelector('input[name="wz-provider"]:checked').value;
    if (provider === 'ollama' && !$('#wz-ollama-model').value) {
      $('#wz-provider-hint').textContent = 'Pick an Ollama model (or pull one first: ollama pull llama3.1), or choose another provider.';
      return false;
    }
    if (provider === 'anthropic' && !$('#wz-anthropic-key').value.trim()) {
      $('#wz-anthropic-key').focus();
      return false;
    }
    if (provider === 'openai' && !$('#wz-openai-url').value.trim()) {
      $('#wz-openai-url').focus();
      return false;
    }
    return true;
  }

  function buildSystemPrompt(name) {
    const description = $('#wz-personality').value.trim();
    const parts = [
      `You are ${name}, the user's personal sovereign AI — private, self-hosted, loyal to the user alone.`,
    ];
    if (description) parts.push(`Your character, in the user's words: ${description}.`);
    if (state.traits.length) parts.push(state.traits.join(' '));
    parts.push('Be genuinely useful. When you are unsure, say so plainly.');
    return parts.join('\n');
  }

  async function finish() {
    const nextBtn = $('#wz-next');
    nextBtn.disabled = true;
    nextBtn.textContent = 'Creating…';
    try {
      const name = $('#wz-name').value.trim();
      const provider = document.querySelector('input[name="wz-provider"]:checked').value;
      const system = buildSystemPrompt(name);
      let model = provider === 'ollama' ? $('#wz-ollama-model').value : '';

      // optionally bake a named local model — the user's own model artifact
      if (provider === 'ollama' && $('#wz-bake').checked && $('#wz-bake-row').style.display !== 'none') {
        nextBtn.textContent = 'Baking your model…';
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'my-ai';
        const baked = await api('POST', '/api/create-model', { name: slug, base: model, system });
        model = baked.model;
      }

      const providersUpdate = {};
      if (provider === 'anthropic') providersUpdate.anthropic = { enabled: true, apiKey: $('#wz-anthropic-key').value.trim() };
      if (provider === 'openai') {
        providersUpdate.openai = { enabled: true, baseUrl: $('#wz-openai-url').value.trim().replace(/\/$/, ''), apiKey: $('#wz-openai-key').value.trim() };
      }

      const persona = await api('POST', '/api/personas', {
        name,
        description: 'Created by the setup wizard',
        system_prompt: system,
        provider,
        model: model || null,
        use_memory: true,
        use_knowledge: true,
      });

      await api('PUT', '/api/config', {
        name,
        providers: providersUpdate,
        defaults: { provider, model, personaId: persona.id },
        memory: { autoExtract: $('#wz-auto-memory').checked },
        setupComplete: true,
      });

      location.reload();
    } catch (err) {
      $('#wz-error').textContent = err.message;
      nextBtn.disabled = false;
      nextBtn.textContent = '⬡ Create my AI';
    }
  }

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
})();
