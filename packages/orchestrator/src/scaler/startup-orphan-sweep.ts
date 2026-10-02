/**
 * Startup orphan cleanup for the scaler backends a process runs.
 *
 * Shared by the coordinator and the worker, which both spawn agents on their
 * own host and so both inherit whatever a crash or an interrupted spawn left
 * behind there.
 */
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { ScalerBackendType } from '@kici-dev/engine';
import type { ScalerBackend } from './types.js';

const logger = createLogger({ prefix: 'scaler' });

/** A backend that can reap its own leaked host resources. */
interface OrphanReaping {
  cleanupOrphans(): Promise<number>;
}

/** A backend that also keeps reaping while the process runs. */
interface PeriodicSweeping {
  startPeriodicOrphanSweep(): void;
}

/**
 * Reap each container and Firecracker backend's orphans once, and start the
 * Firecracker periodic sweep. A failure is logged and never stops startup.
 *
 * The periodic sweep is what reclaims a VM chroot, TAP or IP that a failed
 * spawn could not remove (the jailer had already taken the chroot, or the
 * removal raced the jailer). Startup-only cleanup leaves those to accumulate
 * for as long as the process stays up.
 */
export async function reapOrphansAtStartup(
  backends: ReadonlyArray<{ name: string; backend: ScalerBackend }>,
): Promise<void> {
  for (const { name, backend } of backends) {
    const isContainer = backend.type === ScalerBackendType.enum.container;
    const isFirecracker = backend.type === ScalerBackendType.enum.firecracker;
    if (!isContainer && !isFirecracker) continue;
    try {
      const cleaned = await (backend as unknown as OrphanReaping).cleanupOrphans();
      if (cleaned > 0) {
        logger.info(
          isContainer
            ? `Cleaned up ${cleaned} orphaned containers`
            : `Cleaned up ${cleaned} orphaned Firecracker VMs`,
          { backend: name },
        );
      }
    } catch (err) {
      logger.warn(`${isContainer ? 'Container' : 'Firecracker'} orphan cleanup failed`, {
        backend: name,
        error: toErrorMessage(err),
      });
    }
    if (isFirecracker) (backend as unknown as PeriodicSweeping).startPeriodicOrphanSweep();
  }
}
