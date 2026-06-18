/**
 * Resolve the system-vs-user privilege level for a service lifecycle command.
 *
 * Five CLI verbs (install / start / stop / restart / uninstall) need to agree
 * on whether they're operating against the user-level service
 * (~/Library/LaunchAgents, `systemctl --user`) or the system-level one
 * (/Library/LaunchDaemons, `systemctl`). Default behavior (no flag) is to
 * auto-detect based on UID — non-root → user-level, root → system-level.
 *
 * Explicit `--system` / `--user-level` flags override the auto-detect.
 * They're mutually exclusive: passing both throws. Passing `--system`
 * without root throws with an actionable "re-run under sudo" message.
 */

import { isRoot } from './platform-detect.js';

export interface PrivilegeOpts {
  /** Force system-level install/lifecycle. Requires root. */
  system?: boolean;
  /** Force user-level install/lifecycle. */
  userLevel?: boolean;
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
        '`--system` requires root privileges. Re-run under sudo, e.g. ' +
          '`sudo kici-admin orchestrator install --system ...`.',
      );
    }
    return false;
  }
  if (opts.userLevel) {
    return true;
  }
  return !isRoot();
}
