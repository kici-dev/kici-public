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

  it('reports an already-finished run as untouched, not as cancelled', async () => {
    // The orchestrator leaves a finished run alone, so claiming a cancellation
    // would be false.
    const cancelRun = vi.fn(async () => ({ cancelledJobs: 0, alreadyTerminal: true }));
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({ cancelRun } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => logger);
    const ok = await runsCancelCommand('r1', {});
    expect(ok).toBe(true);
    const printed = String(log.mock.calls[0]?.[0]);
    expect(printed).toContain('had already finished');
    expect(printed).not.toContain('cancelled (');
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
