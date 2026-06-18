import { describe, it, expect, vi, afterEach } from 'vitest';
import { runsShowCommand } from './show.js';
import * as clientMod from '../../remote/dashboard-client.js';

afterEach(() => vi.restoreAllMocks());

describe('runsShowCommand', () => {
  it('prints the run header and the jobs/steps tree', async () => {
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      getRun: async () => ({
        runId: 'r1',
        status: 'success',
        workflowName: 'ci',
        ref: 'main',
        repoIdentifier: 'o/r',
        createdAt: '2026-06-12T00:00:00.000Z',
        startedAt: '2026-06-12T00:00:00.000Z',
      }),
      getRunDetail: async () => ({
        jobs: [
          {
            jobId: 'j1',
            jobName: 'build',
            status: 'success',
            durationMs: 5000,
            steps: [
              {
                stepIndex: 0,
                stepName: 'checkout',
                status: 'success',
                durationMs: 1000,
                exitCode: 0,
              },
            ],
          },
        ],
      }),
    } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await runsShowCommand('r1', {});
    expect(ok).toBe(true);
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('r1');
    expect(printed).toContain('build');
    expect(printed).toContain('checkout');
  });

  it('emits raw JSON with --json', async () => {
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      getRun: async () => ({ runId: 'r1', status: 'success', createdAt: '2026-06-12' }),
      getRunDetail: async () => ({ jobs: [] }),
    } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runsShowCommand('r1', { json: true });
    expect(log.mock.calls.some((c) => String(c[0]).includes('"run"'))).toBe(true);
  });

  it('falls back to local history on a Platform 404', async () => {
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      getRun: async () => {
        throw new clientMod.DashboardClientError('not_found', 'Not found.', 404);
      },
    } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    // No local entry for this id -> returns false, but must not throw.
    const ok = await runsShowCommand('local-xyz', { json: true });
    expect(typeof ok).toBe('boolean');
    void log;
  });
});
