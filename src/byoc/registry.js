import fs from 'node:fs';
import path from 'node:path';

// The control-plane record for BYOC instances. It holds connection metadata
// and health status — an SSH target *reference* (never key material), a hash
// of the instance token (never the plaintext), and version/health facts.
// Losing this file cannot expose customer data; that is the design.

export const INSTANCE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,30}$/;

export function assertInstanceName(name) {
  if (typeof name !== 'string' || !INSTANCE_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid instance name "${name}": use 1-31 chars of lowercase letters, digits, and hyphens, starting with a letter`);
  }
  return name;
}

export function byocDir(rootDir) {
  return path.join(rootDir, 'byoc');
}

export function knownHostsPath(rootDir) {
  return path.join(byocDir(rootDir), 'known_hosts');
}

function registryPath(rootDir) {
  return path.join(byocDir(rootDir), 'instances.json');
}

const SECRET_FIELDS = ['token', 'sovereignToken', 'authToken', 'privateKey', 'keyMaterial', 'password'];

export function openRegistry(rootDir) {
  const file = registryPath(rootDir);

  const readAll = () => {
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  };

  const writeAll = (instances) => {
    fs.mkdirSync(byocDir(rootDir), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(instances, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch (err) {
      if (err.code !== 'EPERM' && err.code !== 'ENOSYS') throw err;
    }
  };

  return {
    path: file,
    list() {
      return Object.values(readAll()).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    },
    get(name) {
      return readAll()[assertInstanceName(name)] ?? null;
    },
    save(record) {
      assertInstanceName(record.name);
      for (const field of SECRET_FIELDS) {
        if (field in record) throw new Error(`Refusing to store secret field "${field}" in the instance registry`);
      }
      const instances = readAll();
      instances[record.name] = { ...record, updatedAt: new Date().toISOString() };
      writeAll(instances);
      return instances[record.name];
    },
    remove(name) {
      const instances = readAll();
      const existed = assertInstanceName(name) in instances;
      delete instances[name];
      writeAll(instances);
      return existed;
    },
  };
}
