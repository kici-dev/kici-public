/**
 * Runner side of an SSH-key git credential: for the length of a write window,
 * the checkout's `core.sshCommand` is the ssh command the agent returned, so
 * git commands run in that checkout reach SSH URLs with the window's key.
 *
 * Per-repository config, not a process-wide `GIT_SSH_COMMAND`: git in any other
 * directory never sees the key. Overlapping windows on one checkout share the
 * setting, and the first opener's prior value comes back when the last closes.
 *
 * `execFileSync` like the clone path: git config is local and fast, and the
 * caller is already inside an async step.
 */

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

interface OpenWindow {
  command: string;
  users: number;
  /** The value before the first window opened; undefined when it was unset. */
  prior: string | undefined;
}

const windows = new Map<string, OpenWindow>();

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function readSshCommand(repoPath: string): string | undefined {
  try {
    return git(repoPath, ['config', '--local', '--get', 'core.sshCommand']).replace(/\n$/, '');
  } catch (err) {
    // `git config --get` exits 1 when the key is unset; anything else is real.
    if ((err as { status?: number }).status === 1) return undefined;
    throw err;
  }
}

/**
 * Set `core.sshCommand` in the checkout at `repoPath` and return its release.
 *
 * Throws when another open window on the same checkout uses a different
 * command: one checkout cannot push with two keys at once. The release is
 * idempotent; the last one restores the prior value or unsets the key.
 */
export function openSshWriteWindow(repoPath: string, sshCommand: string): () => void {
  const key = realpathSync(repoPath);
  let open = windows.get(key);
  if (open && open.command !== sshCommand) {
    throw new Error(
      `another write window on this checkout uses a different SSH key (${repoPath}); ` +
        'close it before opening a window with another credential',
    );
  }
  if (!open) {
    const prior = readSshCommand(key);
    git(key, ['config', '--local', 'core.sshCommand', sshCommand]);
    open = { command: sshCommand, users: 0, prior };
    windows.set(key, open);
  }
  open.users += 1;

  const window = open;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    window.users -= 1;
    if (window.users > 0) return;
    windows.delete(key);
    if (window.prior === undefined) {
      try {
        git(key, ['config', '--local', '--unset', 'core.sshCommand']);
      } catch (err) {
        // Exit 5: the job already removed it, which leaves the state we want.
        if ((err as { status?: number }).status !== 5) throw err;
      }
    } else {
      git(key, ['config', '--local', 'core.sshCommand', window.prior]);
    }
  };
}
