import { describe, it, expect, vi } from 'vitest';
import { reapFirecrackerOrphans } from './reap-orphans.js';
import type { ScalerConfig } from './index.js';

const fcConfig = {
  globalMaxAgents: 10,
  scalers: [
    {
      type: 'firecracker',
      name: 'fc1',
      labelSets: [{ labels: { os: 'linux' }, rootfsPath: '/img/rootfs.ext4' }],
      maxAgents: 5,
      firecrackerPath: '/usr/bin/firecracker',
      jailerPath: '/usr/bin/jailer',
      kernelPath: '/opt/kernels/vmlinux',
      chrootBaseDir: '/srv/jailer',
      uid: 1000,
      gid: 1000,
      requireSudo: true,
    },
  ],
  firecracker: {
    cidr: '10.0.0.0/24',
    gateway: '10.0.0.1',
    netmask: '255.255.255.0',
    bridgeName: 'kici-br0',
  },
} as unknown as ScalerConfig;

describe('reapFirecrackerOrphans', () => {
  it('runs cleanupOrphans for each firecracker scaler and sums the counts', async () => {
    const cleanupSpy = vi
      .spyOn(
        await import('./firecracker-backend.js').then((m) => m.FirecrackerScalerBackend.prototype),
        'cleanupOrphans',
      )
      .mockResolvedValue(3);

    const counts = await reapFirecrackerOrphans(fcConfig);

    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    expect(counts).toEqual({ fc1: 3 });

    cleanupSpy.mockRestore();
  });

  it('returns an empty map when no firecracker scalers are configured', async () => {
    const counts = await reapFirecrackerOrphans({
      ...fcConfig,
      scalers: [],
    } as unknown as ScalerConfig);
    expect(counts).toEqual({});
  });
});
