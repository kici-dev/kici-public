/**
 * Resolve the system-vs-user privilege level for a service lifecycle command.
 *
 * The service lifecycle verbs (install, start, stop, restart, uninstall,
 * status, logs) and `db` need to agree on whether they're operating against
 * the user-level service (~/Library/LaunchAgents, `systemctl --user`) or the
 * system-level one (/Library/LaunchDaemons, `systemctl`). Default behavior
 * (no flag) is to auto-detect based on UID — non-root → user-level, root →
 * system-level.
 *
 * Explicit `--system` / `--user-level` flags override the auto-detect.
 * They're mutually exclusive: passing both throws. Passing `--system`
 * without root throws with a `sudo` command the operator can paste: it names
 * the node binary and CLI script the refused process was actually running,
 * because `sudo` resets PATH to its `secure_path` and cannot find a node that
 * a version manager (nvm, mise, fnm, volta) put on the operator's PATH.
 */

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { isRoot } from './platform-detect.js';

export interface PrivilegeOpts {
  /** Force system-level install/lifecycle. Requires root. */
  system?: boolean;
  /** Force user-level install/lifecycle. */
  userLevel?: boolean;
}

/** The slice of `process` the re-run hint is built from, injectable for tests. */
export interface RerunContext {
  /** `process.execPath` — the node binary actually running. */
  execPath: string;
  /** `process.argv` — `[node, script, ...args]`. */
  argv: readonly string[];
  /** `process.platform`. */
  platform: NodeJS.Platform;
}

/**
 * Quote one token for a POSIX shell: pass a plain token through, single-quote
 * anything carrying a metacharacter (a space in an install path, a quote in a
 * service name) so the printed command parses back into the same argv.
 */
function shellQuote(tok: string): string {
  if (/^[A-Za-z0-9_@./:=,+-]+$/.test(tok)) return tok;
  return `'${tok.replace(/'/g, `'\\''`)}'`;
}

/**
 * Canonicalise the entry script through any symlink (a version manager's shim
 * dir, `/tmp` → `/private/tmp` on macOS) so the printed path is the file node
 * will load. Falls back to a plain `resolve` when the path is not on disk.
 */
function canonicalScript(p: string): string {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p);
  }
}

/**
 * The lines appended to the `--system` refusal: a command that re-runs the
 * refused invocation as root, built from the running process rather than from
 * a literal `kici-admin`, which `sudo` cannot find when node comes from a
 * version manager. On Windows there is no `sudo`; the hint names an elevated
 * shell instead.
 */
export function systemRerunHint(ctx: RerunContext): string {
  if (ctx.platform === 'win32') {
    return 'Re-run the same command from an elevated (Administrator) shell.';
  }
  const [, script, ...args] = ctx.argv;
  const parts = [ctx.execPath, ...(script ? [canonicalScript(script)] : []), ...args];
  return (
    'Re-run under sudo:\n\n' +
    `  sudo ${parts.map(shellQuote).join(' ')}\n\n` +
    "sudo's PATH does not carry a version manager's node (nvm, mise, fnm, volta), " +
    'so the command names the resolved node binary and CLI script instead of `kici-admin`.'
  );
}

export function resolveUserLevel(opts: PrivilegeOpts): boolean {
  if (opts.system && opts.userLevel) {
    throw new Error(
      '`--system` and `--user-level` are mutually exclusive. Pick one (or neither for auto-detect).',
    );
  }
  if (opts.system) {
    if (!isRoot()) {
      throw new Error(
        '`--system` requires root privileges. ' +
          systemRerunHint({
            execPath: process.execPath,
            argv: process.argv,
            platform: process.platform,
          }),
      );
    }
    return false;
  }
  if (opts.userLevel) {
    return true;
  }
  return !isRoot();
}
