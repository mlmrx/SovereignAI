import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// The connector drives the user's own OpenSSH client rather than bundling an
// SSH implementation: zero runtime npm dependencies is a product principle,
// and the platform ssh.exe/ssh is present on Windows 10+, macOS, and Linux.
// Every remote action therefore uses a credential the user granted to their
// own ssh client and can revoke by removing the key from authorized_keys.

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

export class SshError extends Error {
  constructor(message, { code = null, stderr = '' } = {}) {
    super(message);
    this.name = 'SshError';
    this.code = code;
    this.stderr = stderr;
  }
}

/** POSIX single-quote so values survive the remote shell untouched. */
export function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Accept only "user@host"; everything else fails loudly before we connect. */
export function parseSshTarget(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SshError('SSH target is required, e.g. --host deploy@203.0.113.7');
  }
  const raw = value.trim();
  const at = raw.lastIndexOf('@');
  if (at <= 0 || at === raw.length - 1) {
    throw new SshError(`Invalid SSH target "${raw}": expected user@host`);
  }
  const user = raw.slice(0, at);
  const host = raw.slice(at + 1);
  if (!/^[A-Za-z_][A-Za-z0-9._-]*$/.test(user)) {
    throw new SshError(`Invalid SSH user "${user}"`);
  }
  const bracketless = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const validHost =
    /^[A-Za-z0-9]([A-Za-z0-9.-]{0,252}[A-Za-z0-9])?$/.test(bracketless) || /^[0-9a-fA-F:]+$/.test(bracketless);
  if (!validHost) throw new SshError(`Invalid SSH host "${host}"`);
  return { user, host: bracketless, target: `${user}@${bracketless}` };
}

/**
 * Build a runner bound to one host. `strictHostKey` is false only for the
 * first contact of a deploy (accept-new pins the key into our own
 * known_hosts); every later session requires the pinned key so a changed
 * host key fails loudly instead of being silently re-trusted.
 */
export function createSshRunner({ target, sshPort = 22, keyPath = null, knownHostsFile, strictHostKey = true }) {
  const parsed = parseSshTarget(target);
  if (!knownHostsFile) throw new SshError('knownHostsFile is required');
  fs.mkdirSync(path.dirname(knownHostsFile), { recursive: true });

  const baseArgs = () => {
    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      '-o', `StrictHostKeyChecking=${strictHostKey ? 'yes' : 'accept-new'}`,
      '-o', `UserKnownHostsFile="${knownHostsFile}"`,
      '-p', String(sshPort),
    ];
    if (keyPath) args.push('-o', 'IdentitiesOnly=yes', '-i', keyPath);
    return args;
  };

  return {
    describe: () => `${parsed.target}${sshPort === 22 ? '' : ` (port ${sshPort})`}`,
    target: parsed.target,
    host: parsed.host,
    sshPort,
    keyPath,

    /**
     * Run one remote command. `stdin` (string or Buffer) is how scripts and
     * build contexts travel — piping `sh -s` a script avoids ssh argument
     * quoting entirely. `stdoutFile` streams large outputs (exports) straight
     * to a local file instead of buffering.
     */
    exec(command, { stdin = null, timeoutMs = DEFAULT_TIMEOUT_MS, maxBuffer = DEFAULT_MAX_BUFFER, stdoutFile = null } = {}) {
      const args = [...baseArgs(), parsed.target, '--', command];
      return new Promise((resolve, reject) => {
        let child;
        try {
          child = spawn('ssh', args, { windowsHide: true });
        } catch (err) {
          reject(new SshError(`Could not start the OpenSSH client: ${err.message}`));
          return;
        }
        child.once('error', (err) => {
          reject(new SshError(err.code === 'ENOENT'
            ? 'OpenSSH client ("ssh") was not found on this machine. Install OpenSSH Client (built into Windows 10+, macOS, and Linux).'
            : `ssh failed to start: ${err.message}`));
        });

        const stdoutChunks = [];
        const stderrChunks = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let timedOut = false;
        const outStream = stdoutFile ? fs.createWriteStream(stdoutFile, { mode: 0o600 }) : null;

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeoutMs);

        child.stdout.on('data', (chunk) => {
          if (outStream) {
            outStream.write(chunk);
            stdoutBytes += chunk.length;
            return;
          }
          stdoutBytes += chunk.length;
          if (stdoutBytes <= maxBuffer) stdoutChunks.push(chunk);
        });
        child.stderr.on('data', (chunk) => {
          stderrBytes += chunk.length;
          if (stderrBytes <= 1024 * 1024) stderrChunks.push(chunk);
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          const finish = () => {
            const stdout = Buffer.concat(stdoutChunks).toString('utf8');
            const stderr = Buffer.concat(stderrChunks).toString('utf8');
            if (timedOut) {
              reject(new SshError(`Remote command timed out after ${Math.round(timeoutMs / 1000)}s`, { code: null, stderr }));
              return;
            }
            if (stdoutBytes > maxBuffer && !outStream) {
              reject(new SshError('Remote command produced more output than expected', { code, stderr }));
              return;
            }
            resolve({ code, stdout, stderr, stdoutBytes });
          };
          if (outStream) outStream.end(finish);
          else finish();
        });

        if (stdin !== null && stdin !== undefined) child.stdin.end(stdin);
        else child.stdin.end();
      });
    },
  };
}

/**
 * Read the fingerprint our known_hosts pinned for this host — recorded in the
 * instance registry so the user can audit exactly which machine we trusted.
 */
export function pinnedHostKeyFingerprint({ host, sshPort = 22, knownHostsFile }) {
  return new Promise((resolve) => {
    const lookup = sshPort === 22 ? host : `[${host}]:${sshPort}`;
    let child;
    try {
      child = spawn('ssh-keygen', ['-F', lookup, '-f', knownHostsFile, '-l'], { windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    child.once('error', () => resolve(null));
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.once('close', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const match = text.match(/\b(SHA256:[A-Za-z0-9+/=]+)/);
      resolve(match ? match[1] : null);
    });
  });
}
