/**
 * Resolve system- vs user-level for the service lifecycle verbs and `db`, so
 * they agree on the target (`systemctl --user` / LaunchAgents vs `systemctl` /
 * LaunchDaemons). No flag auto-detects by UID: non-root is user-level.
 *
 * `--system` and `--user-level` are mutually exclusive. `--system` without
 * root throws with a pasteable `sudo` command naming the running node binary
 * and CLI script, because `sudo` resets PATH to `secure_path` and loses a
 * version manager's node (nvm, mise, fnm, volta).
 */

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { isRoot } from './platform-detect.js';

export interface PrivilegeOpts {
  /** Requires root. */
  system?: boolean;
  userLevel?: boolean;
}

/** The slice of `process` the re-run hint uses, injectable for tests. */
export interface RerunContext {
  execPath: string;
  /** `[node, script, ...args]`. */
  argv: readonly string[];
  platform: NodeJS.Platform;
}

/** POSIX-quote a token with a metacharacter so the printed command parses back to the same argv. */
function shellQuote(tok: string): string {
  if (/^[A-Za-z0-9_@./:=,+-]+$/.test(tok)) return tok;
  return `'${tok.replace(/'/g, `'\\''`)}'`;
}

/**
 * Resolve symlinks (a version manager's shim dir, macOS `/tmp`) so the printed
 * path is the file node loads; plain `resolve` when the path is not on disk.
 */
function canonicalScript(p: string): string {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p);
  }
}

/**
 * A root re-run command built from the running process, not a literal
 * `kici-admin`; on Windows, an elevated shell instead.
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
