import { describe, it, expect, vi, afterEach } from 'vitest';
import { runsLogsCommand } from './logs.js';
import * as clientMod from '../../remote/dashboard-client.js';

afterEach(() => vi.restoreAllMocks());

describe('runsLogsCommand', () => {
  it('prints step logs in order with headers', async () => {
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      getRun: async () => ({ runId: 'r1', status: 'success' }),
      getRunDetail: async () => ({
        jobs: [
          {
            jobId: 'j1',
            jobName: 'build',
            status: 'success',
            steps: [{ stepIndex: 0, stepName: 'checkout', status: 'success' }],
          },
        ],
      }),
      getStepLogs: async () => ({ lines: ['hello', 'world'], totalLines: 2 }),
    } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await runsLogsCommand('r1', {});
    expect(ok).toBe(true);
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('build');
    expect(printed).toContain('checkout');
    expect(printed).toContain('hello');
  });

  it('filters to a single job with --job', async () => {
    const getStepLogs = vi.fn(async () => ({ lines: ['x'], totalLines: 1 }));
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      getRun: async () => ({ runId: 'r1', status: 'success' }),
      getRunDetail: async () => ({
        jobs: [
          {
            jobId: 'j1',
            jobName: 'build',
            status: 'success',
            steps: [{ stepIndex: 0, stepName: 's', status: 'success' }],
          },
          {
            jobId: 'j2',
            jobName: 'test',
            status: 'success',
            steps: [{ stepIndex: 0, stepName: 's', status: 'success' }],
          },
        ],
      }),
      getStepLogs,
    } as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runsLogsCommand('r1', { job: 'test' });
    expect(getStepLogs).toHaveBeenCalledTimes(1);
    expect(getStepLogs).toHaveBeenCalledWith('r1', 'j2', 0);
  });
});
