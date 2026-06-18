import { describe, it, expect, vi } from 'vitest';
import { runDiskGuard } from './disk-guard.js';
import type { ScalerConfig } from './index.js';

const cfg = (chrootBaseDir = '/srv/jailer') =>
  ({
    scalers: [{ type: 'firecracker', name: 'fc1', chrootBaseDir }],
  }) as unknown as ScalerConfig;

describe('runDiskGuard', () => {
  it('no-ops when free space is above the threshold', async () => {
    const reap = vi.fn();
    const result = await runDiskGuard({
      scalerConfig: cfg(),
      thresholdBytes: 1_000,
      statfsFn: async () => ({ bavail: 10n, bsize: 4096 }) as never,
      reapFn: reap,
    });
    expect(reap).not.toHaveBeenCalled();
    expect(result).toEqual({ reaped: false, recovered: true, freeBytesAfter: expect.any(Number) });
  });

  it('reaps when below threshold and reports recovery when space is freed', async () => {
    const reap = vi.fn(async () => ({ fc1: 5 }));
    const free = [100, 5_000]; // before: 100 (below), after: 5000 (above)
    let call = 0;
    const result = await runDiskGuard({
      scalerConfig: cfg(),
      thresholdBytes: 1_000,
      statfsFn: async () => ({ bavail: BigInt(free[call++]), bsize: 1 }) as never,
      reapFn: reap,
    });
    expect(reap).toHaveBeenCalledOnce();
    expect(result.reaped).toBe(true);
    expect(result.recovered).toBe(true);
  });

  it('reaps but reports NOT recovered when still below threshold', async () => {
    const reap = vi.fn(async () => ({ fc1: 0 }));
    const result = await runDiskGuard({
      scalerConfig: cfg(),
      thresholdBytes: 1_000,
      statfsFn: async () => ({ bavail: 100n, bsize: 1 }) as never,
      reapFn: reap,
    });
    expect(result).toMatchObject({ reaped: true, recovered: false });
  });

  it('no-ops (recovered) when there is no firecracker scaler', async () => {
    const reap = vi.fn();
    const result = await runDiskGuard({
      scalerConfig: { scalers: [{ type: 'container', name: 'c1' }] } as unknown as ScalerConfig,
      thresholdBytes: 1_000,
      statfsFn: async () => ({ bavail: 0n, bsize: 1 }) as never,
      reapFn: reap,
    });
    expect(reap).not.toHaveBeenCalled();
    expect(result.recovered).toBe(true);
    expect(result.reaped).toBe(false);
  });
});
