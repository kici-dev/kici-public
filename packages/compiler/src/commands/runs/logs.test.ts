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

describe('runsLogsCommand unwraps stored log envelopes', () => {
  const ENVELOPE =
    '{"ts":"2026-09-12T09:30:49.325Z","level":"stdout","msg":"smoke test passed","meta":{}}';

  it('prints the text of each envelope, not the envelope', async () => {
    // fails-when: the text mode prints `logs.lines` verbatim — the shape that
    // shipped — so a developer reading `kici runs logs` sees the store's
    // {"ts":…,"level":"stdout","msg":…} for every line the job printed.
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      getRun: async () => ({ runId: 'r1', status: 'success' }),
      getRunDetail: async () => ({
        jobs: [
          {
            jobId: 'j1',
            jobName: 'build',
            status: 'success',
            steps: [{ stepIndex: 0, stepName: 'verify', status: 'success' }],
          },
        ],
      }),
      getStepLogs: async () => ({ lines: [ENVELOPE, 'plain line'], totalLines: 2 }),
    } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runsLogsCommand('r1', {});
    const printed = log.mock.calls.map((c) => String(c[0]));
    expect(printed).toContain('smoke test passed');
    expect(printed).not.toContain(ENVELOPE);
    // breaks-if-wrong: a line that is not an envelope still reaches the
    // terminal as itself.
    expect(printed).toContain('plain line');
  });

  it('unwraps in --follow mode too', async () => {
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      getRun: async () => ({ runId: 'r1', status: 'success' }),
      getRunDetail: async () => ({
        jobs: [
          {
            jobId: 'j1',
            jobName: 'build',
            status: 'success',
            steps: [{ stepIndex: 0, stepName: 'verify', status: 'success' }],
          },
        ],
      }),
      getStepLogs: async () => ({ lines: [ENVELOPE], totalLines: 1 }),
    } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await runsLogsCommand('r1', { follow: true });
    expect(ok).toBe(true);
    const printed = log.mock.calls.map((c) => String(c[0]));
    expect(printed).toContain('smoke test passed');
    expect(printed).not.toContain(ENVELOPE);
  });
});
