/**
 * SSH auth helper for universal-git sources.
 *
 * When a universal-git source uses `credentialType: 'ssh'`, the agent needs
 * three things to run `git clone`:
 *   1. The PEM-encoded private key materialized to a tempfile with mode 0600.
 *   2. A `GIT_SSH_COMMAND` that points `ssh -i` at that tempfile.
 *   3. A `StrictHostKeyChecking` policy that matches the source config —
 *      either `accept-new` (TOFU) or `yes` with a pinned `known_hosts` file.
 *
 * This module provides the orchestrator-side primitives for preparing those
 * artefacts. It is used in two contexts:
 *   - **Agent-side** (Phase 4+): the agent receives the PEM + host-key policy
 *     in the dispatch message and materializes them before cloning.
 *   - **Lock-file fetcher** (Phase 2, this module's immediate consumer):
 *     the orchestrator shallow-clones the source repo itself at registration
 *     time, using the same SSH materialization path.
 *
 * All materialized tempfiles are created under `os.tmpdir()` in a private
 * per-call subdirectory (`fs.mkdtempSync(.../kici-ugit-ssh-`)`), so
 * concurrent clones never clobber each other. The returned `cleanup()`
 * closure removes the directory recursively — callers MUST call it in a
 * `finally` block.
 */

import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SshHostKeyPolicy } from './config.js';

/** Material the caller has prepared (key file + optional known_hosts file). */
export interface SshAuthArtefacts {
  /** Absolute path to the private key file (mode 0600). */
  privateKeyPath: string;
  /** Absolute path to the known_hosts file, if `policy === 'pinned'`. */
  knownHostsPath?: string;
  /** Complete GIT_SSH_COMMAND string to export when running git. */
  gitSshCommand: string;
  /** Dispose of every tempfile + the parent directory. Must be called. */
  cleanup: () => Promise<void>;
}

/**
 * Synchronous variant — used when the caller is already in synchronous
 * lock-file fetching logic. The structure matches the async version so
 * callers can swap freely.
 */
export interface SshAuthArtefactsSync {
  privateKeyPath: string;
  knownHostsPath?: string;
  gitSshCommand: string;
  cleanup: () => void;
}

/** Options common to both sync and async variants. */
export interface PrepareSshAuthOptions {
  /** PEM-encoded private key. */
  privateKey: string;
  /** Host-key verification policy. */
  policy: SshHostKeyPolicy;
  /**
   * OpenSSH known_hosts content. Required when `policy === 'pinned'`, ignored
   * otherwise.
   */
  knownHostsPem?: string;
}

/**
 * Async: materialize the private key (and pinned known_hosts) into a private
 * tempdir, returning paths + the `GIT_SSH_COMMAND` the agent should export.
 *
 * @throws If `policy === 'pinned'` and `knownHostsPem` is missing.
 */
export async function prepareSshAuth(opts: PrepareSshAuthOptions): Promise<SshAuthArtefacts> {
  assertPinnedHasKnownHosts(opts);
  const dir = await mkdtemp(join(tmpdir(), 'kici-ugit-ssh-'));

  const keyPath = join(dir, 'id_key');
  await writeFile(keyPath, normaliseKey(opts.privateKey), { mode: 0o600 });
  await chmod(keyPath, 0o600);

  // Always materialize a per-call known_hosts file — empty for accept-new
  // (TOFU on the empty cache), populated for pinned. This isolates the
  // orchestrator from the runtime user's ~/.ssh/known_hosts: no stale
  // entries from prior forges on the same host:port can block a clone, and
  // the orchestrator never mutates the operator's global SSH state.
  const knownHostsPath = join(dir, 'known_hosts');
  const knownHostsBody = opts.policy === 'pinned' ? opts.knownHostsPem! : '';
  await writeFile(knownHostsPath, knownHostsBody, { mode: 0o600 });
  await chmod(knownHostsPath, 0o600);

  return {
    privateKeyPath: keyPath,
    knownHostsPath,
    gitSshCommand: composeGitSshCommand(keyPath, opts.policy, knownHostsPath),
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Sync variant of `prepareSshAuth`. Semantics are identical; the caller
 * receives a synchronous `cleanup()` closure.
 */
export function prepareSshAuthSync(opts: PrepareSshAuthOptions): SshAuthArtefactsSync {
  assertPinnedHasKnownHosts(opts);
  const dir = mkdtempSync(join(tmpdir(), 'kici-ugit-ssh-'));

  const keyPath = join(dir, 'id_key');
  writeFileSync(keyPath, normaliseKey(opts.privateKey), { mode: 0o600 });
  chmodSync(keyPath, 0o600);

  // See `prepareSshAuth` for the per-call known_hosts isolation rationale.
  const knownHostsPath = join(dir, 'known_hosts');
  const knownHostsBody = opts.policy === 'pinned' ? opts.knownHostsPem! : '';
  writeFileSync(knownHostsPath, knownHostsBody, { mode: 0o600 });
  chmodSync(knownHostsPath, 0o600);

  return {
    privateKeyPath: keyPath,
    knownHostsPath,
    gitSshCommand: composeGitSshCommand(keyPath, opts.policy, knownHostsPath),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Compose the GIT_SSH_COMMAND string. Honors the host-key policy:
 *   - `accept-new`: `StrictHostKeyChecking=accept-new` (TOFU on the per-call
 *     empty known_hosts file).
 *   - `pinned`: `StrictHostKeyChecking=yes` (rejects any unknown host key).
 *
 * Both policies pin `UserKnownHostsFile` to the per-call tempfile so the
 * orchestrator never reads or writes the runtime user's
 * `~/.ssh/known_hosts`. Without this, a stale entry there for a host:port
 * we're cloning from blocks the connection (accept-new still rejects
 * mismatches against cached keys). The per-call file is wiped by `cleanup()`.
 *
 * IdentitiesOnly=yes ensures ssh ignores any agent-forwarded keys and only
 * uses the one we provided; this is critical in staging where the runner
 * user may have a populated ssh-agent.
 */
export function composeGitSshCommand(
  privateKeyPath: string,
  policy: SshHostKeyPolicy,
  knownHostsPath: string,
): string {
  const flags = [
    `ssh -i ${quoteShell(privateKeyPath)}`,
    '-o IdentitiesOnly=yes',
    '-o BatchMode=yes',
    `-o UserKnownHostsFile=${quoteShell(knownHostsPath)}`,
  ];
  flags.push(
    policy === 'pinned' ? '-o StrictHostKeyChecking=yes' : '-o StrictHostKeyChecking=accept-new',
  );
  return flags.join(' ');
}

/** Enforce the "pinned requires known_hosts" invariant one level above Zod. */
function assertPinnedHasKnownHosts(opts: PrepareSshAuthOptions): void {
  if (opts.policy === 'pinned' && !opts.knownHostsPem) {
    throw new Error(
      'prepareSshAuth: sshHostKeyPolicy is "pinned" but no knownHostsPem was provided',
    );
  }
}

/**
 * Ensure the PEM content ends with a trailing newline — ssh's parser
 * rejects keys that lack it, and the customer-supplied value may arrive
 * trimmed through the CLI.
 */
function normaliseKey(pem: string): string {
  if (pem.endsWith('\n')) return pem;
  return `${pem}\n`;
}

/**
 * Shell-quote a path for embedding in `GIT_SSH_COMMAND`. Single-quotes the
 * string and escapes embedded single quotes — matches POSIX shell parsing.
 */
export function quoteShell(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}
