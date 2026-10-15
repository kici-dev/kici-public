/**
 * Cross-OS reboot of the agent's own host for the workflow-level `restartHost()`
 * step; the caller issues it once the job is fully reported. Rebooting needs
 * root/admin. If the spawn fails, the caller clears the orchestrator's
 * reboot-pending flag and surfaces the error; the deadline sweep is the backstop.
 */

import { spawn } from 'node:child_process';
import { createLogger } from '@kici-dev/shared';

const logger = createLogger({ prefix: 'reboot' });

/** The OS reboot primitive for a Node platform string; kept pure for unit-testing. */
export function rebootCommandFor(platform: NodeJS.Platform): { cmd: string; args: string[] } {
  switch (platform) {
    case 'darwin':
      return { cmd: 'shutdown', args: ['-r', 'now'] };
    case 'win32':
      return { cmd: 'shutdown', args: ['/r', '/t', '0'] };
    default:
      // linux + the BSDs. A host without systemd needs the operator to grant
      // `shutdown -r`; a non-zero exit surfaces as a privilege/availability error.
      return { cmd: 'systemctl', args: ['reboot'] };
  }
}

/**
 * Issue the OS reboot detached; resolves once spawned. Rejects when the spawn
 * fails (e.g. a missing binary). A privilege denial usually shows as a non-zero
 * exit AFTER spawn and is only logged: the box may already be going down.
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
