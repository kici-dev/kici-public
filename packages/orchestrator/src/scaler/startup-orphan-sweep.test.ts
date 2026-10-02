import { describe, it, expect, vi } from 'vitest';
import { ScalerBackendType } from '@kici-dev/engine';
import { reapOrphansAtStartup } from './startup-orphan-sweep.js';
import type { ScalerBackend } from './types.js';

/** A backend of `type` with spies for the two sweep entry points. */
function backend(type: string, cleanupOrphans = vi.fn(async () => 0)) {
  const startPeriodicOrphanSweep = vi.fn();
  const b = { type, cleanupOrphans, startPeriodicOrphanSweep } as unknown as ScalerBackend;
  return { b, cleanupOrphans, startPeriodicOrphanSweep };
}

describe('reapOrphansAtStartup', () => {
  it('reaps Firecracker orphans once and keeps sweeping', async () => {
    const fc = backend(ScalerBackendType.enum.firecracker);

    await reapOrphansAtStartup([{ name: 'fc', backend: fc.b }]);

    // fails-when: a process (the worker did) skips the Firecracker sweep, so a
    // chroot a failed spawn could not remove is never reclaimed while it runs.
    expect(fc.cleanupOrphans).toHaveBeenCalledTimes(1);
    expect(fc.startPeriodicOrphanSweep).toHaveBeenCalledTimes(1);
  });

  it('reaps container orphans once, without a periodic sweep', async () => {
    const c = backend(ScalerBackendType.enum.container);

    await reapOrphansAtStartup([{ name: 'c', backend: c.b }]);

    expect(c.cleanupOrphans).toHaveBeenCalledTimes(1);
    expect(c.startPeriodicOrphanSweep).not.toHaveBeenCalled();
  });

  it('starts the sweep and moves on when a startup cleanup throws', async () => {
    // breaks-if-wrong: a failing first pass must not leave the host without
    // the sweep, or stop the next backend's cleanup.
    const fc = backend(
      ScalerBackendType.enum.firecracker,
      vi.fn(async () => {
        throw new Error('EACCES');
      }),
    );
    const c = backend(ScalerBackendType.enum.container);

    await reapOrphansAtStartup([
      { name: 'fc', backend: fc.b },
      { name: 'c', backend: c.b },
    ]);

    expect(fc.startPeriodicOrphanSweep).toHaveBeenCalledTimes(1);
    expect(c.cleanupOrphans).toHaveBeenCalledTimes(1);
  });

  it('leaves other backend types alone', async () => {
    const bm = backend(ScalerBackendType.enum['bare-metal']);

    await reapOrphansAtStartup([{ name: 'bm', backend: bm.b }]);

    expect(bm.cleanupOrphans).not.toHaveBeenCalled();
    expect(bm.startPeriodicOrphanSweep).not.toHaveBeenCalled();
  });
});
