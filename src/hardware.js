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
 *      so this is the probe that decides whether the sparse tier is servable.
 *   3. `rocm-smi --showmeminfo vram --showproductname --json` — AMD, where
 *      ROCm is installed. Reports the product name too, so an AMD card is
 *      badged with what it actually is.
 *   4. Linux sysfs, which needs no vendor tooling at all:
 *        device/mem_info_vram_total          (amdgpu, and Intel Arc under i915)
 *        device/tile0/vram0/total_bytes      (Intel Arc under the newer xe driver)
 *      The card gets its vendor name from device/vendor (0x1002 AMD,
 *      0x8086 Intel, 0x10de NVIDIA) — sysfs has no product-name file, and a
 *      vendor is more honest than a blank.
 *   5. Otherwise unknown, and unknown is a real answer.
 *
 * The badge is the point of steps 3 and 4. FreeToken is NVIDIA-only, so the
 * sparse tier's engine gate does not move: an AMD or Intel machine gets an
 * honest GPU line and the dense shelf, not a promise about MoE.
 *
 * Deliberately NOT probed: the Windows registry (HardwareInformation.qwMemorySize
 * lives under a driver-class GUID whose subkey numbering is unstable) and WMI
 * (Win32_VideoController.AdapterRAM is a uint32 — it reports 4 GB for a 24 GB
 * card — and `wmic` was removed in Windows 11 24H2, so it would need a
 * PowerShell spawn per request). Between nvidia-smi, rocm-smi and sysfs, every
 * GPU we can size is covered without any of that.
 */
import { spawn as spawnChild } from 'node:child_process';
import { readdir as readdirFs, readFile as readFileFs } from 'node:fs/promises';

const MIB = 2 ** 20;
// An unknown result may be a slow first nvidia-smi that hit the timeout; retry it later.
const RETRY_UNKNOWN_MS = 60_000;
const UNKNOWN = Object.freeze({ vramBytes: null, name: null, vendor: null, unifiedMemory: false, source: null });

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

/**
 * Parse `rocm-smi --showmeminfo vram --showproductname --json`, whose output
 * is one object per card:
 *   { "card0": { "VRAM Total Memory (B)": "21458059264",
 *                "Card Series": "Radeon RX 7900 XT", ... } }
 * Keys have varied across ROCm versions ("Card Series" / "Card SKU" /
 * "Card model"), so the memory field is matched on shape rather than on an
 * exact string, and the name is whichever of the known keys is present.
 * Like the NVIDIA parser, the largest adapter wins.
 */
export function parseRocmSmi(output) {
  let cards;
  try {
    cards = JSON.parse(String(output ?? ''));
  } catch {
    return null;
  }
  if (!cards || typeof cards !== 'object') return null;
  let best = null;
  for (const [card, fields] of Object.entries(cards)) {
    if (!/^card\d+$/i.test(card) || !fields || typeof fields !== 'object') continue;
    const memoryKey = Object.keys(fields).find((key) => /^vram total memory/i.test(key));
    if (!memoryKey) continue;
    const bytes = Number(String(fields[memoryKey]).trim());
    if (!Number.isFinite(bytes) || bytes <= 0) continue;
    const nameKey = Object.keys(fields).find((key) => /^card (series|model|sku)$/i.test(key));
    const rawName = nameKey ? String(fields[nameKey]).trim() : '';
    // "0x744c" is the PCI device id, not a name a person recognizes.
    const name = rawName && !/^0x[0-9a-f]+$/i.test(rawName) ? rawName.slice(0, 120) : null;
    if (!best || bytes > best.vramBytes) best = { vramBytes: bytes, name };
  }
  return best;
}

/** Run a probe binary, returning its stdout on exit 0 and null on anything else. */
function runProbe(spawn, command, args, timeoutMs) {
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
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
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
      finish(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

// The vendors whose ids appear in /sys/class/drm/cardN/device/vendor. sysfs has
// no product-name file, so the badge says "AMD GPU" rather than nothing — a
// vendor is a real fact, and the VRAM number beside it is the one that matters.
const PCI_VENDORS = {
  '0x1002': { vendor: 'amd', name: 'AMD GPU' },
  '0x8086': { vendor: 'intel', name: 'Intel GPU' },
  '0x10de': { vendor: 'nvidia', name: 'NVIDIA GPU' },
};

// Where a discrete card reports its own memory, in bytes. The first covers
// amdgpu and Intel Arc under i915; the second is Intel Arc under the newer xe
// driver. Integrated graphics report 0 or nothing, which is correct: they have
// no dedicated VRAM, and the RAM rule already covers them.
const SYSFS_VRAM_FILES = ['device/mem_info_vram_total', 'device/tile0/vram0/total_bytes'];

async function readSysfsVram(readdir, readFile) {
  let cards;
  try {
    cards = await readdir('/sys/class/drm');
  } catch {
    return null;
  }
  let best = null;
  for (const card of cards) {
    if (!/^card\d+$/.test(card)) continue;
    let bytes = 0;
    for (const file of SYSFS_VRAM_FILES) {
      try {
        const value = Number(String(await readFile(`/sys/class/drm/${card}/${file}`, 'utf8')).trim());
        if (Number.isFinite(value) && value > bytes) bytes = value;
      } catch {
        /* not every card or driver exposes every path */
      }
    }
    if (bytes <= 0 || (best && bytes <= best.vramBytes)) continue;
    let identity = null;
    try {
      const id = String(await readFile(`/sys/class/drm/${card}/device/vendor`, 'utf8')).trim().toLowerCase();
      identity = PCI_VENDORS[id] ?? null;
    } catch {
      /* the vendor file is optional too */
    }
    best = { vramBytes: bytes, name: identity?.name ?? null, vendor: identity?.vendor ?? null };
  }
  return best;
}

/**
 * Build a memoized `detectGpu()`; every collaborator is injectable so tests
 * never touch the real machine. The first call runs the probe, later calls
 * share its promise — hardware does not change under a running server.
 *
 * Resolves `{ vramBytes: number|null, name: string|null, vendor: 'nvidia'|'amd'|'intel'|'apple'|null, unifiedMemory: boolean,
 * source: 'nvidia-smi'|'rocm-smi'|'sysfs'|'unified'|'disabled'|null }`.
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
        return { vramBytes: null, name: 'Apple Silicon (unified memory)', vendor: 'apple', unifiedMemory: true, source: 'unified' };
      }
      // NVIDIA first: it is the only vendor FreeToken can serve the sparse
      // tier on, so its answer settles the most.
      const nvidia = parseNvidiaSmi(
        await runProbe(spawn, 'nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], timeoutMs)
      );
      if (nvidia) return { vramBytes: nvidia.vramBytes, name: nvidia.name, vendor: 'nvidia', unifiedMemory: false, source: 'nvidia-smi' };

      const amd = parseRocmSmi(await runProbe(spawn, 'rocm-smi', ['--showmeminfo', 'vram', '--showproductname', '--json'], timeoutMs));
      if (amd) return { vramBytes: amd.vramBytes, name: amd.name, vendor: 'amd', unifiedMemory: false, source: 'rocm-smi' };

      // No vendor tooling required — this is what catches an AMD or Intel card
      // on a machine with only the kernel driver installed.
      if (platform === 'linux') {
        const card = await readSysfsVram(readdir, readFile);
        if (card) return { vramBytes: card.vramBytes, name: card.name, vendor: card.vendor, unifiedMemory: false, source: 'sysfs' };
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
