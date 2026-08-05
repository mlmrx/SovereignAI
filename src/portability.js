import crypto from 'node:crypto';

/**
 * The portable export envelope: what `sovereign export` writes, `sovereign
 * import` reads, and docs/EXPORT_FORMAT.md documents for anyone else who
 * wants to read or produce it without SovereignAI.
 *
 * The manifest exists so an archive can be *verified*, not just trusted: it
 * records a SHA-256 per table plus one archive digest. Verification detects
 * corruption, truncation, and silent modification. It is integrity, not
 * authenticity — there is no key or signature, so it proves the file matches
 * itself, not who wrote it. That limit is documented rather than implied away.
 */

export const EXPORT_FORMAT = 'sovereignai-export/1';
export const ENCRYPTED_FORMAT = 'sovereignai-export-encrypted/1';
export const MANIFEST_ALGORITHM = 'sha256-json-v1';

export class PortabilityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PortabilityError';
  }
}

/** Assemble the plaintext export envelope, manifest included. */
export function buildExport(store, version) {
  const data = store.exportAll();
  return {
    sovereignai: version,
    format: EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    manifest: buildManifest(data),
    data,
  };
}

/**
 * Per-table digest of the canonical JSON serialization. JSON.parse preserves
 * the key order this process wrote, so hashing `JSON.stringify(rows)` of the
 * in-memory value gives the same digest on export and on re-parse — no
 * canonicalization scheme needed as long as the file itself is the thing
 * being verified.
 */
export function buildManifest(data) {
  const tables = {};
  for (const [name, rows] of Object.entries(data)) {
    tables[name] = { rows: rows.length, sha256: sha256Hex(JSON.stringify(rows)) };
  }
  return {
    algorithm: MANIFEST_ALGORITHM,
    tables,
    // One digest over the per-table digests (sorted by table name) so a
    // single value can stand for the whole archive in a backup log.
    sha256: sha256Hex(
      Object.keys(tables)
        .sort()
        .map((name) => `${name}:${tables[name].sha256}`)
        .join('\n')
    ),
  };
}

/**
 * Check a parsed export against its own manifest.
 * Returns { status: 'verified' | 'mismatch' | 'absent', mismatches }.
 * A missing manifest is not an error — exports predating v0.5 have none.
 */
export function verifyExportManifest(parsed) {
  if (!parsed || typeof parsed !== 'object' || !parsed.data || typeof parsed.data !== 'object') {
    throw new PortabilityError('Not a SovereignAI export: missing data');
  }
  const manifest = parsed.manifest;
  if (!manifest || typeof manifest !== 'object') return { status: 'absent', mismatches: [] };
  if (manifest.algorithm !== MANIFEST_ALGORITHM) {
    return {
      status: 'mismatch',
      mismatches: [{ table: '(manifest)', detail: `unknown algorithm "${manifest.algorithm}" — this build verifies ${MANIFEST_ALGORITHM}` }],
    };
  }
  const actual = buildManifest(parsed.data);
  const mismatches = [];
  const declared = manifest.tables && typeof manifest.tables === 'object' ? manifest.tables : {};
  for (const name of new Set([...Object.keys(declared), ...Object.keys(actual.tables)])) {
    const want = declared[name];
    const got = actual.tables[name];
    if (!want) mismatches.push({ table: name, detail: 'present in data but missing from manifest' });
    else if (!got) mismatches.push({ table: name, detail: 'listed in manifest but missing from data' });
    else if (want.sha256 !== got.sha256 || want.rows !== got.rows) {
      mismatches.push({ table: name, detail: `expected ${want.rows} rows / ${short(want.sha256)}, found ${got.rows} rows / ${short(got.sha256)}` });
    }
  }
  if (typeof manifest.sha256 === 'string' && manifest.sha256 !== actual.sha256 && !mismatches.length) {
    mismatches.push({ table: '(archive)', detail: 'archive digest does not match its tables' });
  }
  return { status: mismatches.length ? 'mismatch' : 'verified', mismatches };
}

// ---- Encrypted archives (user-held passphrase) ----
//
// AES-256-GCM with an scrypt-derived key. Every parameter needed to decrypt
// (except the passphrase) lives in the envelope, so the file is
// self-describing and decryptable by standard tooling without SovereignAI.
// This protects the archive at rest — on a rented GPU host, a shared drive,
// a cloud backup. It deliberately does NOT encrypt the live database, and it
// does not change what a BYOC host operator can read while an instance runs.

const SCRYPT = { N: 1 << 17, r: 8, p: 1 }; // 128 MiB derivation — raises offline brute-force cost on a stolen archive
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const SCRYPT_BOUNDS = { maxN: 1 << 20, maxR: 32, maxP: 16 }; // refuse absurd params from untrusted files
const MIN_PASSPHRASE = 12;

export function encryptExport(plaintextJson, passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) {
    throw new PortabilityError(`Passphrase must be at least ${MIN_PASSPHRASE} characters — a short one is brute-forceable if the archive is stolen`);
  }
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32, { ...SCRYPT, maxmem: SCRYPT_MAXMEM });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintextJson, 'utf8'), cipher.final()]);
  return {
    format: ENCRYPTED_FORMAT,
    kdf: { name: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64') },
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64') },
    ciphertext: ciphertext.toString('base64'),
  };
}

export function isEncryptedExport(parsed) {
  return Boolean(parsed && typeof parsed === 'object' && parsed.format === ENCRYPTED_FORMAT);
}

export function decryptExport(parsed, passphrase) {
  if (!isEncryptedExport(parsed)) throw new PortabilityError('Not an encrypted SovereignAI export');
  const kdf = parsed.kdf ?? {};
  const cipher = parsed.cipher ?? {};
  if (kdf.name !== 'scrypt' || cipher.name !== 'aes-256-gcm') {
    throw new PortabilityError(`Unsupported kdf/cipher (${kdf.name}/${cipher.name}); this build supports scrypt + aes-256-gcm`);
  }
  const { N, r, p } = kdf;
  if (
    !Number.isSafeInteger(N) || N < 2 || (N & (N - 1)) !== 0 || N > SCRYPT_BOUNDS.maxN ||
    !Number.isSafeInteger(r) || r < 1 || r > SCRYPT_BOUNDS.maxR ||
    !Number.isSafeInteger(p) || p < 1 || p > SCRYPT_BOUNDS.maxP ||
    // Reject any combination whose working set would exceed our maxmem, so a
    // crafted file fails as a clean PortabilityError instead of a raw throw
    // from scryptSync (128 * N * r bytes is scrypt's memory lower bound).
    128 * N * r > SCRYPT_MAXMEM
  ) {
    throw new PortabilityError('Encrypted export declares out-of-bounds scrypt parameters; refusing to derive');
  }
  const salt = fromBase64(kdf.salt, 'kdf.salt');
  const iv = fromBase64(cipher.iv, 'cipher.iv');
  const authTag = fromBase64(cipher.authTag, 'cipher.authTag');
  const ciphertext = fromBase64(parsed.ciphertext, 'ciphertext');
  try {
    const key = crypto.scryptSync(passphrase, salt, 32, { N, r, p, maxmem: SCRYPT_MAXMEM });
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new PortabilityError('Decryption failed: wrong passphrase, or the file was modified');
  }
}

function fromBase64(value, label) {
  if (typeof value !== 'string' || !value) throw new PortabilityError(`Encrypted export is missing ${label}`);
  const buffer = Buffer.from(value, 'base64');
  if (!buffer.length) throw new PortabilityError(`Encrypted export has an empty ${label}`);
  return buffer;
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function short(hash) {
  return typeof hash === 'string' ? hash.slice(0, 12) : String(hash);
}
