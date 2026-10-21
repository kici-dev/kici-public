import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { logger } from '@kici-dev/core';
import { runsCancelCommand } from './cancel.js';
import * as clientMod from '../../remote/dashboard-client.js';
import * as directMod from '../../remote/direct-cancel.js';
import * as configMod from '../../remote/config.js';

// The Platform cases below must not pick up a direct target from the shell.
beforeEach(() => {
  vi.stubEnv('KICI_ORCHESTRATOR_TOKEN', '');
  vi.stubEnv('KICI_ORCHESTRATOR_URL', '');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** A run id the commands accept as a full id. */
const RUN = '0f1e2d3c-0000-4000-8000-000000000001';

describe('runsCancelCommand', () => {
  it('cancels a single run', async () => {
    const cancelRun = vi.fn(async () => ({ cancelledJobs: 3 }));
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({ cancelRun } as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => logger);
    const ok = await runsCancelCommand(RUN, { force: true });
    expect(ok).toBe(true);
    expect(cancelRun).toHaveBeenCalledWith(RUN, true);
  });

  it('reports an already-finished run as untouched, not as cancelled', async () => {
    // The orchestrator leaves a finished run alone; claiming a cancellation would be false.
    const cancelRun = vi.fn(async () => ({ cancelledJobs: 0, alreadyTerminal: true }));
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({ cancelRun } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => logger);
    const ok = await runsCancelCommand(RUN, {});
    expect(ok).toBe(true);
    const printed = String(log.mock.calls[0]?.[0]);
    expect(printed).toContain('had already finished');
    expect(printed).not.toContain('cancelled (');
  });

  it('cancels the run a unique short id names', async () => {
    const cancelRun = vi.fn(async () => ({ cancelledJobs: 1 }));
    const listRuns = vi.fn(async () => ({ runs: [{ runId: RUN }], hasMore: false }));
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      cancelRun,
      listRuns,
    } as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => logger);

    // fails-when: the short id is sent as a run id, and the Platform answers "Run not found"
    expect(await runsCancelCommand('0f1e2d3c', {})).toBe(true);
    expect(cancelRun).toHaveBeenCalledWith(RUN, false);
  });

  it('makes no lookup for a full run id', async () => {
    const listRuns = vi.fn();
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      cancelRun: async () => ({ cancelledJobs: 1 }),
      listRuns,
    } as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => logger);

    expect(await runsCancelCommand(RUN, {})).toBe(true);
    expect(listRuns).not.toHaveBeenCalled();
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

  it('cancels on the orchestrator the env selects, not through the Platform', async () => {
    vi.stubEnv('KICI_ORCHESTRATOR_URL', 'http://127.0.0.1:4319');
    vi.stubEnv('KICI_ORCHESTRATOR_TOKEN', 'plane-tok');
    vi.spyOn(configMod, 'loadGlobalConfig').mockResolvedValue({
      platformEndpoint: 'https://api.kici.dev',
      pat: 'kici_pat',
      activeOrgId: 'o',
    });
    const direct = vi
      .spyOn(directMod, 'cancelRunDirect')
      .mockResolvedValue({ alreadyTerminal: false, cancelledJobs: 1 });
    const load = vi.spyOn(clientMod.DashboardClient, 'load');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => logger);
    // fails-when: the command asks the Platform, which has never seen a local-plane run.
    expect(await runsCancelCommand(RUN, { force: true })).toBe(true);
    expect(direct).toHaveBeenCalledWith('http://127.0.0.1:4319', 'plane-tok', RUN, {
      force: true,
    });
    expect(load).not.toHaveBeenCalled();
  });

  it('refuses a short id on the direct path, where no run list resolves it', async () => {
    vi.spyOn(configMod, 'loadGlobalConfig').mockResolvedValue({});
    vi.stubEnv('KICI_ORCHESTRATOR_TOKEN', 'plane-tok');
    const direct = vi.spyOn(directMod, 'cancelRunDirect');
    const err = vi.spyOn(logger, 'error').mockImplementation(() => logger);

    // fails-when: the short id reaches the orchestrator, which answers "Run not found"
    expect(await runsCancelCommand('0f1e2d3c', { orchestratorUrl: 'http://127.0.0.1:4319' })).toBe(
      false,
    );
    expect(String(err.mock.calls[0]?.[0])).toContain('pass the full run id');
    expect(direct).not.toHaveBeenCalled();
  });

  it('refuses --branch combined with --orchestrator-url instead of dropping a flag', async () => {
    const load = vi.spyOn(clientMod.DashboardClient, 'load');
    const err = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    // fails-when: one of the two flags is silently ignored.
    expect(
      await runsCancelCommand(undefined, {
        branch: 'main',
        orchestratorUrl: 'http://127.0.0.1:4319',
      }),
    ).toBe(false);
    expect(String(err.mock.calls[0]?.[0])).toContain('cannot be combined');
    expect(load).not.toHaveBeenCalled();
  });

  it('errors when neither run id nor branch is given', async () => {
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({} as never);
    const err = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const ok = await runsCancelCommand(undefined, {});
    expect(ok).toBe(false);
    expect(err).toHaveBeenCalled();
  });
});
