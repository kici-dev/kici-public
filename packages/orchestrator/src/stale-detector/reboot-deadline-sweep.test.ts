import { describe, it, expect, vi } from 'vitest';
import { RebootDeadlineSweep } from './reboot-deadline-sweep.js';

describe('RebootDeadlineSweep', () => {
  it('clears every expired reboot-pending flag', async () => {
    const cleared: string[] = [];
    const sweep = new RebootDeadlineSweep({
      rosterStore: {
        listExpiredRebootPending: vi.fn(async () => ['expired-a', 'expired-b']),
        clearRebootPending: vi.fn(async (id: string) => {
          cleared.push(id);
        }),
      },
    });

    await sweep.scan();

    expect(cleared).toEqual(['expired-a', 'expired-b']);
  });

  it('is a no-op when nothing is expired', async () => {
    const clear = vi.fn(async () => {});
    const sweep = new RebootDeadlineSweep({
      rosterStore: {
        listExpiredRebootPending: vi.fn(async () => []),
        clearRebootPending: clear,
      },
    });

    await sweep.scan();

    expect(clear).not.toHaveBeenCalled();
  });

  it('swallows a store error so the leader tick keeps running', async () => {
    const sweep = new RebootDeadlineSweep({
      rosterStore: {
        listExpiredRebootPending: vi.fn(async () => {
          throw new Error('db down');
        }),
        clearRebootPending: vi.fn(async () => {}),
      },
    });

    await expect(sweep.scan()).resolves.toBeUndefined();
  });
});
