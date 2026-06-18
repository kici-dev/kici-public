// SSH auth setup for `git clone` with a provider-supplied private key.
//
// Writes the private key (and optionally a pinned known_hosts file) to a
// temporary directory with restrictive permissions, then composes the
// `GIT_SSH_COMMAND` env var that `git clone` picks up. The caller MUST call
// the returned `cleanup()` in a `finally` block to wipe the tempdir — the
// key never touches persistent storage.

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SshAuthSetup {
  /** Value for the `GIT_SSH_COMMAND` env var. */
  gitSshCommand: string;
  /** Absolute path of the tempdir — used by tests. Not safe to log. */
  tempDir: string;
  /** Removes the tempdir and its contents. Safe to call multiple times. */
  cleanup(): Promise<void>;
}

export interface SetupSshAuthOpts {
  /** PEM-encoded private key. Must include trailing newline. */
  privateKey: string;
  /** 'accept-new' (default) trusts first-seen host keys; 'pinned' requires `knownHosts`. */
  hostKeyPolicy?: 'accept-new' | 'pinned';
  /** OpenSSH known_hosts content. Required when `hostKeyPolicy === 'pinned'`. */
  knownHosts?: string;
}

/**
 * Materialize an SSH private key (and optional pinned known_hosts) into a
 * tempdir and build the `GIT_SSH_COMMAND` that `git clone` needs.
 *
 * Permissions:
 *   - private key mode 0o600 (required by OpenSSH — refuses to use world-
 *     readable keys).
 *   - known_hosts mode 0o600.
 *   - tempdir mode 0o700.
 *
 * SSH flags composed:
 *   - `-i <keyfile>` — identity file.
 *   - `-o IdentitiesOnly=yes` — don't try other keys from ssh-agent / ~/.ssh.
 *   - `-o BatchMode=yes` — never prompt for passwords / passphrases.
 *   - host-key checking flags based on `hostKeyPolicy`.
 */
export async function setupSshAuth(opts: SetupSshAuthOpts): Promise<SshAuthSetup> {
  if (opts.hostKeyPolicy === 'pinned' && !opts.knownHosts) {
    throw new Error('pinned hostKeyPolicy requires knownHosts content');
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'kici-ssh-'));
  const keyPath = join(tempDir, 'id');
  const pem = opts.privateKey.endsWith('\n') ? opts.privateKey : `${opts.privateKey}\n`;
  await writeFile(keyPath, pem, { mode: 0o600 });

  // Always materialize a per-call known_hosts file — empty for accept-new
  // (TOFU on the empty cache), populated for pinned. Without an explicit
  // UserKnownHostsFile, ssh would fall back to the runtime user's
  // ~/.ssh/known_hosts, where a stale entry for the same host:port (e.g.
  // an earlier forge bound to that port) would block the clone because
  // accept-new still rejects mismatches against cached keys. The per-call
  // file is wiped by cleanup() so the agent never mutates global SSH state.
  const knownHostsPath = join(tempDir, 'known_hosts');
  const knownHostsBody = opts.hostKeyPolicy === 'pinned' ? opts.knownHosts! : '';
  await writeFile(knownHostsPath, knownHostsBody, { mode: 0o600 });

  const parts: string[] = [
    'ssh',
    '-i',
    escapeShellArg(keyPath),
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'BatchMode=yes',
    '-o',
    `UserKnownHostsFile=${escapeShellArg(knownHostsPath)}`,
  ];

  if (opts.hostKeyPolicy === 'pinned') {
    parts.push('-o', 'StrictHostKeyChecking=yes');
  } else {
    parts.push('-o', 'StrictHostKeyChecking=accept-new');
  }

  const gitSshCommand = parts.join(' ');

  return {
    gitSshCommand,
    tempDir,
    async cleanup() {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

/**
 * Quote a path for inclusion in `GIT_SSH_COMMAND`. We use single-quote
 * wrapping so backslashes and spaces survive git's shell-parse of the
 * command value.
 */
function escapeShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
