'use strict';
/* A day with a sovereign AI — six scenes, each replaying shipped behavior.
   External file (not inline) so the page renders identically under the strict
   CSP the product's own server sends. Nothing here talks to a network: the
   scenes are scripted replays, and the page says so. */

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, reduced ? 0 : ms));
async function typeInto(el, text, speed = 14) {
  if (reduced) { el.textContent = text; return; }
  el.textContent = '';
  for (const ch of text) { el.textContent += ch; await sleep(speed); }
}
function once(btn, fn) {
  if (!btn) return;
  btn.addEventListener('click', async () => { btn.disabled = true; await fn(); btn.disabled = false; });
}
const $ = (sel) => document.querySelector(sel);

/* 07:04 — the arrival */
once($('#s1-play'), async () => {
  const status = $('#s1-status');
  const cells = $('#s1-cells');
  const greeting = $('#s1-greeting');
  cells.replaceChildren();
  greeting.textContent = '';
  status.textContent = 'Importing 212 conversations from chatgpt…';
  await sleep(700);
  for (let i = 1; i <= 14; i++) {
    status.textContent = `Distilling — swept ${Math.min(i * 16, 212)} of 212 conversations…`;
    const c = document.createElement('span');
    c.className = 'cell';
    cells.appendChild(c);
    await sleep(170);
  }
  status.textContent = 'Done: 14 durable memories — every one names the conversation it came from.';
  await typeInto(greeting, '"Good morning. I know you now: you are building SovereignAI, you like answers short with the reasoning shown, and you decided in March to keep the mortgage variable — I have the receipts for all of it."');
});

/* 09:12 — the editor */
once($('#s2-play'), async () => {
  const toast = $('#s2-toast');
  toast.textContent = '';
  await sleep(250);
  toast.textContent = '✓ Saved to knowledge: retry-policy.ts (lines 15–16) — retrievable in chat, over MCP, and from every other channel.';
});

/* 11:30 — a frontier model, reading your memory over MCP */
once($('#s3-play'), async () => {
  const out = $('#s3-out');
  out.replaceChildren();
  const chip = document.createElement('span');
  chip.className = 'toolchip';
  chip.textContent = '⚒ sovereign · search_memory("demo scheduling")';
  out.appendChild(chip);
  await sleep(900);
  const bubble = document.createElement('div');
  bubble.className = 'bubble claude';
  out.appendChild(bubble);
  const answer = document.createElement('span');
  bubble.appendChild(answer);
  await typeInto(answer, 'Your team prefers Friday demos with everyone present — you recorded that yourself on July 9. I would put the walkthrough this Friday afternoon.');
  const cite = document.createElement('span');
  cite.className = 'cite';
  cite.innerHTML = '<b>from your ledger:</b> "Prefers Friday demos with the whole team" · added by you · Jul 9';
  bubble.appendChild(cite);
});

/* 14:45 — the renewals radar, on a device you own */
once($('#s4-play'), async () => {
  const out = $('#s4-out');
  out.replaceChildren();
  const items = [
    ['Shield Insurance policy', 'renews in 12 days · $1,240'],
    ['IronWorks Gym contract', 'auto-renews in 29 days — cancel window closes in 1 day'],
  ];
  for (const [title, meta] of items) {
    const el = document.createElement('div');
    el.className = 'radar-item';
    const strong = document.createElement('div');
    strong.textContent = title;
    const small = document.createElement('span');
    small.className = 'mono';
    small.textContent = meta;
    el.append(strong, small);
    out.appendChild(el);
    await sleep(350);
  }
});

/* 18:20 — the exit drill */
once($('#s5-play'), async () => {
  const out = $('#s5-out');
  out.innerHTML = '';
  const lines = [
    ['t-cmd', '$ sovereign export --encrypt backup.json'],
    ['', 'Exported 4,318 rows to backup.json (encrypted: aes-256-gcm, scrypt-derived key)'],
    ['t-dim', 'Archive digest sha256:9f41c2ab7e02…'],
    ['t-cmd', '$ sovereign verify backup.json'],
    ['t-ok', '  ✓ memories    ✓ conversations    ✓ documents    ✓ life_records — all verified'],
    ['t-ok', 'Result: verified. Your exit works. It always has to.'],
  ];
  for (const [cls, text] of lines) {
    const div = document.createElement('div');
    if (cls) div.className = cls;
    out.appendChild(div);
    await typeInto(div, text, 6);
  }
});

/* 21:00 — striking a memory is a real delete, so it looks like one */
document.querySelectorAll('#s6-out .strike').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const item = btn.closest('.ledger-item');
    item.classList.add('gone');
    await sleep(500);
    item.remove();
    if (!$('#s6-out .ledger-item')) {
      $('#s6-out').innerHTML = '<p class="mono" style="color:var(--screen-muted);font-size:12px">Ledger empty. Nothing retained, nothing recoverable — that is the point.</p>';
    }
  });
});

/* The access map — every entry names a shipped mechanism */
const CHANNELS = {
  run: [
    ['single binary', 'One file — runtime, app, and UI inside. Download, check it against the release SHA256SUMS, run it. Windows, macOS, Linux.'],
    ['docker', 'One command pulls the published image and boots the real product, with your state in a volume you own.'],
    ['from source', 'Clone and run with nothing but Node. Zero npm dependencies: the code you audit is the code that runs.'],
    ['your VPS or homelab', 'sovereign byoc deploy --host you@your-box: a hardened deploy over SSH to any Docker host you own, with host-key pinning, health-checked upgrades, and verifiable delete.'],
    ['rented GPU', 'sovereign byoc gpu serve runs open weights on rented compute. That is tenancy, not sovereignty — and the deploy plan prints exactly which guarantees change before you provision.'],
  ],
  reach: [
    ['web command center', 'Mind view, chat with citations, the memory ledger, the knowledge atlas, Model Studio, the Fine-Tuning Studio. No build step, no telemetry.'],
    ['your phone', 'sovereign start --lan puts the full UI on any device on your network, behind a bearer token that rides in the URL fragment and never reaches a server log.'],
    ['the CLI', 'import-chat, import-email, distill, portfolio, export, verify, doctor — every heavy operation is scriptable.'],
    ['Claude, Cursor, Codex…', 'sovereign mcp gives any MCP client tool access to your memory and knowledge: Claude Desktop and Code, Cursor, Windsurf, Codex CLI, Gemini CLI.'],
    ['VS Code and JetBrains', 'Ask about a selection, or save it to knowledge, without leaving the editor.'],
    ['browser extension', 'Right-click any page to save it into knowledge or memory.'],
    ['ChatGPT Actions', 'Even ChatGPT can query your instance — through an Actions schema you host yourself.'],
  ],
  leave: [
    ['verified export', 'Every table, checksummed, in a documented format, with optional passphrase encryption. sovereign verify proves an archive without importing it.'],
    ['the portfolio', 'Memories with provenance, personas, and a knowledge inventory distilled into one markdown file — pasteable into any AI you will ever use.'],
    ['export-to-owner', 'A remote instance streams its whole workspace home over the SSH rail; destroy --purge-data then verifies the removal.'],
  ],
};
const detail = $('#channel-detail');
for (const [group, items] of Object.entries(CHANNELS)) {
  const host = document.querySelector(`[data-group="${group}"]`);
  if (!host) continue;
  for (const [name, text] of items) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.type = 'button';
    chip.textContent = name;
    chip.addEventListener('click', () => {
      document.querySelectorAll('.chip.on').forEach((c) => c.classList.remove('on'));
      chip.classList.add('on');
      detail.replaceChildren();
      const b = document.createElement('b');
      b.textContent = name;
      detail.append(b, ` — ${text}`);
    });
    host.appendChild(chip);
  }
}
