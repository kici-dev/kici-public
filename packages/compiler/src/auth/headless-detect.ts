import { existsSync } from 'node:fs';
import { isCiEnvironment } from '@kici-dev/core/ci-env';
import pc from 'picocolors';
import { canAccessPowerShell, isWsl } from 'wsl-utils';

/** Deadline for the WSL interop probe. A healthy probe answers in single-digit ms. */
export const WSL_INTEROP_PROBE_TIMEOUT_MS = 2_000;

/**
 * Run the Windows-interop probe under a deadline.
 *
 * `canAccessPowerShell()` does unbounded filesystem I/O against the mounted
 * Windows drive: on a wedged 9p mount it never settles, which would strand the
 * caller. The tri-state result lets the caller tell "the probe said
 * unreachable" from "the probe never answered" — only the latter is announced.
 */
async function probeWithDeadline(timeoutMs: number): Promise<boolean | 'timeout'> {
  const probe = canAccessPowerShell();
  // The abandoned probe is not cancellable and may reject long after the
  // deadline fires; without a handler that becomes an unhandled rejection.
  probe.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([probe, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Detect if the current environment is headless (no browser available).
 *
 * Used to determine whether to use the PKCE localhost callback flow
 * (desktop) or the RFC 8628 device authorization flow (headless/SSH).
 *
 * Checks in order:
 * 1. SSH session (SSH_CONNECTION, SSH_CLIENT, SSH_TTY)
 * 2. CI environments — see `isCiEnvironment` in `@kici-dev/core/ci-env` for the
 *    opt-out convention and why a vendor marker beats `CI=false`.
 * 3. Container environments (container, DOCKER_CONTAINER, and the
 *    /run/.containerenv + /.dockerenv sentinel files)
 * 4. WSL with reachable Windows interop — an interactive desktop, so not
 *    headless. WSL without reachable interop is headless, and so is WSL whose
 *    interop probe does not answer within the deadline (a hung Windows mount).
 * 5. Linux without display server (no DISPLAY and no WAYLAND_DISPLAY)
 */
export async function isHeadless(opts: { probeTimeoutMs?: number } = {}): Promise<boolean> {
  // SSH session. All three markers are checked because `open` consults the same
  // three before it will launch the Windows browser from WSL — a session that
  // kept only SSH_CONNECTION (a sudo shell, an env-filtered remote-dev shell)
  // would otherwise be sent down the browser flow that `open` then refuses.
  if (process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY) return true;

  // CI environments. The opt-out convention (`0` / `false`, any case) and the
  // rule that a vendor marker beats `CI=false` both live in the predicate, so
  // every reader in the codebase agrees about the same shell.
  if (isCiEnvironment()) return true;

  // Container environments. The sentinel files catch a container that does not
  // export an env marker, so a browserless container is always classified as
  // headless before any later, more permissive check runs.
  if (
    process.env.container ||
    process.env.DOCKER_CONTAINER ||
    existsSync('/run/.containerenv') ||
    existsSync('/.dockerenv')
  ) {
    return true;
  }

  // WSL is an interactive desktop only when Windows interop is reachable — the
  // same gate `open` applies before it will launch the Windows browser. When the
  // probe fails, `open` takes its Linux branch, spawns xdg-open, resolves
  // successfully, and no browser ever appears, so the device flow is the working
  // path there. Runs after the SSH/CI/container checks so an SSH session into
  // WSL, or a container on a WSL2 host, stays headless without probing.
  if (isWsl) {
    const reachable = await probeWithDeadline(opts.probeTimeoutMs ?? WSL_INTEROP_PROBE_TIMEOUT_MS);
    if (reachable === 'timeout') {
      console.log(pc.dim('  Windows interop probe timed out — using the device flow.'));
      return true;
    }
    return !reachable;
  }

  // Linux without display server
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return true;
  }

  return false;
}
