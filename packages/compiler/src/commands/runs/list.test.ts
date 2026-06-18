import { describe, it, expect, vi, afterEach } from 'vitest';
import { runsListCommand } from './list.js';
import * as clientMod from '../../remote/dashboard-client.js';

afterEach(() => vi.restoreAllMocks());

describe('runsListCommand', () => {
  it('renders a table of runs and passes filters to the client', async () => {
    const listRuns = vi.fn(async () => ({
      runs: [
        {
          runId: 'r1',
          workflowName: 'ci',
          status: 'success',
          ref: 'main',
          triggerEvent: 'push',
          startedAt: '2026-06-12T00:00:00.000Z',
          durationMs: 5000,
          routingKey: 'github:1',
          createdAt: '2026-06-12T00:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
      hasMore: false,
    }));
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({ listRuns } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await runsListCommand({ status: 'success' });
    expect(ok).toBe(true);
    expect(listRuns).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('ci');
  });

  it('reports an empty state when no runs match', async () => {
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      listRuns: async () => ({ runs: [], total: 0, page: 1, pageSize: 20, hasMore: false }),
    } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await runsListCommand({});
    expect(ok).toBe(true);
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('No runs found');
  });

  it('emits raw JSON with --json', async () => {
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      listRuns: async () => ({ runs: [], total: 0, page: 1, pageSize: 20, hasMore: false }),
    } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runsListCommand({ json: true });
    expect(log.mock.calls.some((c) => String(c[0]).includes('"runs"'))).toBe(true);
  });
});
