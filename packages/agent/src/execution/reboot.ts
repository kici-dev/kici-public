/**
 * Cross-OS host reboot for the workflow-level `restartHost()` step.
 *
 * The agent runs ON the host it executes jobs for, so a `restartHost()` step
 * reboots that host. `rebootCommandFor` is the pure OS→command mapping (kept
 * pure for unit-testing); `issueReboot` spawns it detached with a tiny grace so
 * the job's final flush completes before the box goes down.
 *
 * Rebooting needs host privilege (root/admin). If the primitive is denied, the
 * spawn fails and the caller clears the orchestrator's reboot-pending flag and
 * surfaces the error — the deadline sweep is the backstop.
 */

import { spawn } from 'node:child_process';
import { createLogger } from '@kici-dev/shared';

const logger = createLogger({ prefix: 'reboot' });

/** The OS reboot primitive for a Node platform string. */
export function rebootCommandFor(platform: NodeJS.Platform): { cmd: string; args: string[] } {
  switch (platform) {
    case 'darwin':
      return { cmd: 'shutdown', args: ['-r', 'now'] };
    case 'win32':
      return { cmd: 'shutdown', args: ['/r', '/t', '0'] };
    default:
      // linux + the BSDs: systemctl is the modern path; on a host without
      // systemd the operator must grant `shutdown -r`. We pick systemctl as the
      // default and let a non-zero exit surface as a privilege/availability
      // error the caller reports.
      return { cmd: 'systemctl', args: ['reboot'] };
  }
}

/**
 * Issue the OS reboot detached. Resolves once the child has been spawned (the
 * box is going down; there is nothing to await). Rejects synchronously if the
 * spawn itself fails (e.g. the binary is missing). A privilege denial usually
 * surfaces as a non-zero exit AFTER spawn — logged, not thrown, because by then
 * the box may already be on its way down.
 */
export function issueReboot(platform: NodeJS.Platform = process.platform): Promise<void> {
  const { cmd, args } = rebootCommandFor(platform);
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.on('error', (err) => {
        logger.error('Reboot command failed to spawn', { cmd, args, error: String(err) });
        reject(err);
      });
      child.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          logger.warn('Reboot command exited non-zero (privilege denied?)', { cmd, args, code });
        }
      });
      child.unref();
      logger.info('Issued host reboot', { cmd, args });
      // Resolve on next tick so a synchronous spawn 'error' rejects first.
      setImmediate(resolve);
    } catch (err) {
      reject(err);
    }
  });
}
