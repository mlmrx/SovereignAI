/**
 * Best-effort GPU probe: how much dedicated GPU memory this machine has, so
 * the starter shelf and the model recommendation can size the ACTIVE set of a
 * sparse (MoE) model against it. Zero dependencies, never throws, always
 * resolves — a machine with no GPU tooling gets `null`s, not an error, and
 * the routes that use it stay fast.
 *
 * Detection order:
 *   0. `SOVEREIGN_HARDWARE_PROBE=off` — the operator opted out; nothing spawns.
 *   1. Apple Silicon (darwin/arm64) — unified memory: there is no separate
 *      VRAM number to read, and the RAM rule already covers it.
 *   2. `nvidia-smi --query-gpu=name,memory.total` — ships with the NVIDIA
 *      driver on every OS. FreeToken is NVIDIA-only (RTX 30-series and up),
 *      so this is the one probe that matters.
 *   3. Linux sysfs: /sys/class/drm/cardN/device/mem_info_vram_total (bytes;
 *      amdgpu exposes it, so AMD boxes still get an honest number).
 *   4. Otherwise unknown.
 *
 * Deliberately NOT probed: the Windows registry (HardwareInformation.qwMemorySize
 * lives under a driver-class GUID whose subkey numbering is unstable) and WMI
 * (Win32_VideoController.AdapterRAM is a uint32 — it reports 4 GB for a 24 GB
 * card — and `wmic` was removed in Windows 11 24H2, so it would need a
 * PowerShell spawn per request). nvidia-smi covers the only GPUs FreeToken
 * can use, on every platform, without any of that.
 */
import { spawn as spawnChild } from 'node:child_process';
import { readdir as readdirFs, readFile as readFileFs } from 'node:fs/promises';

const MIB = 2 ** 20;
// An unknown result may be a slow first nvidia-smi that hit the timeout; retry it later.
const RETRY_UNKNOWN_MS = 60_000;
const UNKNOWN = Object.freeze({ vramBytes: null, name: null, unifiedMemory: false, source: null });

/**
 * Parse nvidia-smi CSV lines ("name, MiB") and keep the adapter with the most
 * memory: a laptop may list an integrated adapter first.
 */
export function parseNvidiaSmi(output) {
  let best = null;
  for (const raw of String(output ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const comma = line.lastIndexOf(',');
    if (comma < 0) continue;
    const name = line.slice(0, comma).trim();
    const mib = Number(line.slice(comma + 1).trim());
    if (!name || !Number.isFinite(mib) || mib <= 0) continue;
    if (!best || mib > best.mib) best = { name, mib };
  }
  return best ? { vramBytes: best.mib * MIB, name: best.name } : null;
}

function runNvidiaSmi(spawn, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child?.kill?.(); } catch { /* already gone */ }
      finish(null);
    }, timeoutMs);
    try {
      child = spawn('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      finish(null);
      return;
    }
    if (!child || typeof child.on !== 'function') {
      finish(null);
      return;
    }
    const chunks = [];
    child.stdout?.on?.('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    child.once('error', () => finish(null));
    child.once('close', (code) => {
      if (code !== 0) return finish(null);
      finish(parseNvidiaSmi(Buffer.concat(chunks).toString('utf8')));
    });
  });
}

async function readSysfsVram(readdir, readFile) {
  let cards;
  try {
    cards = await readdir('/sys/class/drm');
  } catch {
    return null;
  }
  let max = 0;
  for (const card of cards) {
    if (!/^card\d+$/.test(card)) continue;
    try {
      const bytes = Number(String(await readFile(`/sys/class/drm/${card}/device/mem_info_vram_total`, 'utf8')).trim());
      if (Number.isFinite(bytes) && bytes > max) max = bytes;
    } catch {
      /* not every card exposes it */
    }
  }
  return max > 0 ? max : null;
}

/**
 * Build a memoized `detectGpu()`; every collaborator is injectable so tests
 * never touch the real machine. The first call runs the probe, later calls
 * share its promise — hardware does not change under a running server.
 *
 * Resolves `{ vramBytes: number|null, name: string|null, unifiedMemory: boolean,
 * source: 'nvidia-smi'|'sysfs'|'unified'|'disabled'|null }`.
 */
export function createGpuProbe({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  spawn = spawnChild,
  readdir = readdirFs,
  readFile = readFileFs,
  timeoutMs = 3000,
  now = Date.now,
} = {}) {
  let pending = null;
  const probe = async () => {
    try {
      if (env?.SOVEREIGN_HARDWARE_PROBE === 'off') return { ...UNKNOWN, source: 'disabled' };
      if (platform === 'darwin' && arch === 'arm64') {
        return { vramBytes: null, name: 'Apple Silicon (unified memory)', unifiedMemory: true, source: 'unified' };
      }
      const nvidia = await runNvidiaSmi(spawn, timeoutMs);
      if (nvidia) return { vramBytes: nvidia.vramBytes, name: nvidia.name, unifiedMemory: false, source: 'nvidia-smi' };
      if (platform === 'linux') {
        const bytes = await readSysfsVram(readdir, readFile);
        if (bytes) return { vramBytes: bytes, name: null, unifiedMemory: false, source: 'sysfs' };
      }
      return { ...UNKNOWN };
    } catch {
      return { ...UNKNOWN };
    }
  };
  // Definitive answers (a GPU, 'disabled', 'unified') are memoized for the life
  // of the process; an unknown one is re-probed after RETRY_UNKNOWN_MS so a
  // transient failure does not read as "no GPU" until the server restarts.
  let retryAt = null;
  return function detectGpu() {
    if (pending && (retryAt === null || now() < retryAt)) return pending;
    pending = probe().then((result) => {
      retryAt = result.source === null ? now() + RETRY_UNKNOWN_MS : null;
      return result;
    });
    return pending;
  };
}

/** The server's shared probe: one detection per process. */
export const detectGpu = createGpuProbe();
