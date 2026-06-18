import { describe, it, expect } from 'vitest';
import { existsSync, statSync, readFileSync } from 'node:fs';
import {
  prepareSshAuth,
  prepareSshAuthSync,
  composeGitSshCommand,
  quoteShell,
} from './ssh-auth.js';

const FAKE_PEM = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----';

describe('prepareSshAuth (async)', () => {
  it('materializes key file with 0600 permissions and trailing newline', async () => {
    const auth = await prepareSshAuth({ privateKey: FAKE_PEM, policy: 'accept-new' });
    try {
      expect(existsSync(auth.privateKeyPath)).toBe(true);
      expect(readFileSync(auth.privateKeyPath, 'utf-8')).toBe(`${FAKE_PEM}\n`);
      if (process.platform !== 'win32') {
        const mode = statSync(auth.privateKeyPath).mode & 0o777;
        expect(mode).toBe(0o600);
      }
    } finally {
      await auth.cleanup();
    }
    expect(existsSync(auth.privateKeyPath)).toBe(false);
  });

  it('accept-new policy composes StrictHostKeyChecking=accept-new with isolated known_hosts', async () => {
    const auth = await prepareSshAuth({ privateKey: FAKE_PEM, policy: 'accept-new' });
    try {
      expect(auth.gitSshCommand).toContain('StrictHostKeyChecking=accept-new');
      expect(auth.gitSshCommand).toContain('IdentitiesOnly=yes');
      // Per-call known_hosts MUST be wired even for accept-new — otherwise
      // ssh falls back to the runtime user's ~/.ssh/known_hosts and a
      // stale entry there for the same host:port blocks the connection.
      expect(auth.gitSshCommand).toContain('UserKnownHostsFile=');
      expect(auth.knownHostsPath).toBeDefined();
      expect(existsSync(auth.knownHostsPath!)).toBe(true);
      expect(readFileSync(auth.knownHostsPath!, 'utf-8')).toBe('');
    } finally {
      await auth.cleanup();
    }
  });

  it('pinned policy writes known_hosts and references it in GIT_SSH_COMMAND', async () => {
    const auth = await prepareSshAuth({
      privateKey: FAKE_PEM,
      policy: 'pinned',
      knownHostsPem: 'forgejo.example.com ssh-ed25519 AAAA…',
    });
    try {
      expect(auth.knownHostsPath).toBeDefined();
      expect(existsSync(auth.knownHostsPath!)).toBe(true);
      expect(readFileSync(auth.knownHostsPath!, 'utf-8')).toContain('ssh-ed25519');
      expect(auth.gitSshCommand).toContain('StrictHostKeyChecking=yes');
      expect(auth.gitSshCommand).toContain(`UserKnownHostsFile=`);
    } finally {
      await auth.cleanup();
    }
  });

  it('throws when pinned policy is chosen without known_hosts', async () => {
    await expect(prepareSshAuth({ privateKey: FAKE_PEM, policy: 'pinned' })).rejects.toThrow(
      /pinned.*knownHostsPem/,
    );
  });

  it('cleanup removes the tempdir idempotently', async () => {
    const auth = await prepareSshAuth({ privateKey: FAKE_PEM, policy: 'accept-new' });
    await auth.cleanup();
    await auth.cleanup(); // second call must not throw
    expect(existsSync(auth.privateKeyPath)).toBe(false);
  });
});

describe('prepareSshAuthSync', () => {
  it('behaves identically to the async variant for accept-new', () => {
    const auth = prepareSshAuthSync({ privateKey: FAKE_PEM, policy: 'accept-new' });
    try {
      expect(existsSync(auth.privateKeyPath)).toBe(true);
      expect(auth.gitSshCommand).toContain('StrictHostKeyChecking=accept-new');
    } finally {
      auth.cleanup();
    }
    expect(existsSync(auth.privateKeyPath)).toBe(false);
  });

  it('writes known_hosts when pinned', () => {
    const auth = prepareSshAuthSync({
      privateKey: FAKE_PEM,
      policy: 'pinned',
      knownHostsPem: 'host ssh-rsa AAAA',
    });
    try {
      expect(auth.knownHostsPath).toBeDefined();
      expect(existsSync(auth.knownHostsPath!)).toBe(true);
    } finally {
      auth.cleanup();
    }
  });
});

describe('composeGitSshCommand', () => {
  it('quotes paths containing spaces safely', () => {
    const cmd = composeGitSshCommand(
      '/tmp/with space/id_key',
      'accept-new',
      '/tmp/with space/known_hosts',
    );
    expect(cmd).toContain(`'/tmp/with space/id_key'`);
    expect(cmd).toContain(`UserKnownHostsFile='/tmp/with space/known_hosts'`);
  });

  it('always wires UserKnownHostsFile (no fallback to ~/.ssh)', () => {
    const acceptNew = composeGitSshCommand('/tmp/k', 'accept-new', '/tmp/kh');
    const pinned = composeGitSshCommand('/tmp/k', 'pinned', '/tmp/kh');
    expect(acceptNew).toContain(`UserKnownHostsFile='/tmp/kh'`);
    expect(acceptNew).toContain('StrictHostKeyChecking=accept-new');
    expect(pinned).toContain(`UserKnownHostsFile='/tmp/kh'`);
    expect(pinned).toContain('StrictHostKeyChecking=yes');
  });
});

describe('quoteShell', () => {
  it('wraps in single quotes', () => {
    expect(quoteShell('/a/b')).toBe(`'/a/b'`);
  });

  it('escapes embedded single quotes', () => {
    expect(quoteShell(`/a/'b`)).toBe(`'/a/'\\''b'`);
  });
});
