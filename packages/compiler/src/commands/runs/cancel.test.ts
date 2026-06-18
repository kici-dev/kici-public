import { describe, it, expect, vi, afterEach } from 'vitest';
import { logger } from '@kici-dev/core';
import { runsCancelCommand } from './cancel.js';
import * as clientMod from '../../remote/dashboard-client.js';

afterEach(() => vi.restoreAllMocks());

describe('runsCancelCommand', () => {
  it('cancels a single run', async () => {
    const cancelRun = vi.fn(async () => ({ cancelledJobs: 3 }));
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({ cancelRun } as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => logger);
    const ok = await runsCancelCommand('r1', { force: true });
    expect(ok).toBe(true);
    expect(cancelRun).toHaveBeenCalledWith('r1', true);
  });

  it('cancels by branch when --branch is given', async () => {
    const cancelByBranch = vi.fn(async () => ({ cancelledRuns: 2 }));
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({ cancelByBranch } as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => logger);
    const ok = await runsCancelCommand(undefined, { branch: 'main' });
    expect(ok).toBe(true);
    expect(cancelByBranch).toHaveBeenCalledWith('main');
  });

  it('errors when neither run id nor branch is given', async () => {
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({} as never);
    const err = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const ok = await runsCancelCommand(undefined, {});
    expect(ok).toBe(false);
    expect(err).toHaveBeenCalled();
  });
});
