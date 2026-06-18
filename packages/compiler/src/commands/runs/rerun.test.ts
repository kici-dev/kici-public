import { describe, it, expect, vi, afterEach } from 'vitest';
import { logger } from '@kici-dev/core';
import { runsRerunCommand } from './rerun.js';
import * as clientMod from '../../remote/dashboard-client.js';

afterEach(() => vi.restoreAllMocks());

describe('runsRerunCommand', () => {
  it('reports the new run id', async () => {
    const rerunRun = vi.fn(async () => ({ newRunId: 'r2' }));
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({ rerunRun } as never);
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await runsRerunCommand('r1', {});
    expect(ok).toBe(true);
    expect(rerunRun).toHaveBeenCalledWith('r1');
    expect(info.mock.calls.map((c) => String(c[0])).join('\n')).toContain('r2');
  });

  it('surfaces a cooldown error clearly', async () => {
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      rerunRun: async () => {
        throw new clientMod.DashboardClientError('cooldown', 'Wait 5s.', 429);
      },
    } as never);
    const err = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const ok = await runsRerunCommand('r1', {});
    expect(ok).toBe(false);
    expect(err).toHaveBeenCalled();
  });
});
