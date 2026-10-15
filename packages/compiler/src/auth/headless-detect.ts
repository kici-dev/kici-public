import { existsSync } from 'node:fs';
import { isCiEnvironment } from '@kici-dev/core/ci-env';
import pc from 'picocolors';
import { canAccessPowerShell, isWsl } from 'wsl-utils';

/** Deadline for the WSL interop probe. A healthy probe answers in single-digit ms. */
export const WSL_INTEROP_PROBE_TIMEOUT_MS = 2_000;

/**
 * `canAccessPowerShell()` does unbounded I/O against the mounted Windows drive
 * and never settles on a wedged 9p mount. `'timeout'` tells "never answered"
 * (announced) apart from "unreachable".
 */
async function probeWithDeadline(timeoutMs: number): Promise<boolean | 'timeout'> {
  const probe = canAccessPowerShell();
  // The abandoned probe may reject after the deadline; avoid an unhandled rejection.
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
 * Headless (no browser): use the RFC 8628 device flow instead of the PKCE
 * localhost callback. Checked in order: SSH, CI, container, WSL interop, and
 * Linux with neither DISPLAY nor WAYLAND_DISPLAY.
 */
export async function isHeadless(opts: { probeTimeoutMs?: number } = {}): Promise<boolean> {
  // `open` checks all three before launching the Windows browser from WSL, so a
  // session keeping only one (a sudo shell) must still count as SSH.
  if (process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY) return true;

  // The opt-out convention and "a vendor marker beats CI=false" live in the
  // shared predicate.
  if (isCiEnvironment()) return true;

  // The sentinel files catch a container exporting no env marker.
  if (
    process.env.container ||
    process.env.DOCKER_CONTAINER ||
    existsSync('/run/.containerenv') ||
    existsSync('/.dockerenv')
  ) {
    return true;
  }

  // WSL is a desktop only with reachable Windows interop, the gate `open`
  // applies; without it `open` spawns xdg-open, resolves, and no browser
  // appears. Runs after SSH/CI/container so those stay headless without probing.
  if (isWsl) {
    const reachable = await probeWithDeadline(opts.probeTimeoutMs ?? WSL_INTEROP_PROBE_TIMEOUT_MS);
    if (reachable === 'timeout') {
      console.log(pc.dim('  Windows interop probe timed out — using the device flow.'));
      return true;
    }
    return !reachable;
  }

  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return true;
  }

  return false;
}
