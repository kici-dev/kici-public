import { describe, it, expect, vi } from 'vitest';
import { reapGroup } from './fork-runner.js';

describe('reapGroup', () => {
  it('sends SIGTERM then SIGKILL to the group when detached', async () => {
    const kills: Array<[number, NodeJS.Signals]> = [];
    const killFn = (p: number, s: NodeJS.Signals) => {
      kills.push([p, s]);
      return 1;
    };
    const attempts = await reapGroup(4242, true, killFn, 0);
    expect(kills).toEqual([
      [4242, 'SIGTERM'],
      [4242, 'SIGKILL'],
    ]);
    expect(attempts).toBeGreaterThanOrEqual(1);
  });

  it('is a no-op returning 0 when not detached', async () => {
    const killFn = vi.fn().mockReturnValue(1);
    expect(await reapGroup(4242, false, killFn, 0)).toBe(0);
    expect(killFn).not.toHaveBeenCalled();
  });

  it('is a no-op returning 0 when the pid is undefined', async () => {
    const killFn = vi.fn().mockReturnValue(1);
    expect(await reapGroup(undefined, true, killFn, 0)).toBe(0);
    expect(killFn).not.toHaveBeenCalled();
  });

  it('skips the SIGKILL escalation when SIGTERM signals an already-gone group', async () => {
    // SIGTERM returns 0 (ESRCH — group already gone), so there is nothing to
    // escalate: the SIGKILL attempt must not fire and no grace is waited.
    const killFn = vi.fn().mockReturnValue(0);
    expect(await reapGroup(4242, true, killFn, 5000)).toBe(0);
    expect(killFn).toHaveBeenCalledTimes(1);
    expect(killFn).toHaveBeenCalledWith(4242, 'SIGTERM');
  });
});
