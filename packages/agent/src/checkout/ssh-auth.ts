// SSH auth for `git clone` with a provider-supplied private key: writes the key
// (and a known_hosts file) to a restrictive tempdir and composes
// `GIT_SSH_COMMAND`. The caller MUST call `cleanup()` in a `finally`, so the key
// never reaches persistent storage.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir } from '@kici-dev/core/tmp';

export interface SshAuthSetup {
  gitSshCommand: string;
  /** Used by tests. Not safe to log. */
  tempDir: string;
  /** Idempotent. */
  cleanup(): Promise<void>;
}

export interface SetupSshAuthOpts {
  /** PEM-encoded; a missing trailing newline is added. */
  privateKey: string;
  /** 'accept-new' (default) trusts first-seen host keys; 'pinned' requires `knownHosts`. */
  hostKeyPolicy?: 'accept-new' | 'pinned';
  /** OpenSSH known_hosts content. Required when `hostKeyPolicy === 'pinned'`. */
  knownHosts?: string;
}

/**
 * Permissions: key and known_hosts 0o600 (OpenSSH refuses a world-readable
 * key), tempdir 0o700.
 *
 * SSH flags: `-i <keyfile>`; `IdentitiesOnly=yes` (no ssh-agent / ~/.ssh keys);
 * `BatchMode=yes` (never prompt); host-key checking per `hostKeyPolicy`.
 */
export async function setupSshAuth(opts: SetupSshAuthOpts): Promise<SshAuthSetup> {
  if (opts.hostKeyPolicy === 'pinned' && !opts.knownHosts) {
    throw new Error('pinned hostKeyPolicy requires knownHosts content');
  }

  const { path: tempDir, cleanup } = await makeTempDir('ssh');
  const keyPath = join(tempDir, 'id');
  const pem = opts.privateKey.endsWith('\n') ? opts.privateKey : `${opts.privateKey}\n`;
  await writeFile(keyPath, pem, { mode: 0o600 });

  // Always a per-call known_hosts (empty for accept-new, populated for pinned).
  // Otherwise ssh falls back to ~/.ssh/known_hosts, where a stale entry for the
  // same host:port blocks the clone (accept-new still rejects mismatches), and
  // the agent would mutate global SSH state.
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
    cleanup,
  };
}

/** Single-quote a path so backslashes and spaces survive git's shell-parse of `GIT_SSH_COMMAND`. */
function escapeShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
