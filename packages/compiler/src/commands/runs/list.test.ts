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
      nextCursor: null,
      prevCursor: null,
      hasMore: false,
      approxTotal: 1,
      pageSize: 20,
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
      listRuns: async () => ({
        runs: [],
        nextCursor: null,
        prevCursor: null,
        hasMore: false,
        approxTotal: 0,
        pageSize: 20,
      }),
      getWebhookActivity: async () => null,
    } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await runsListCommand({});
    expect(ok).toBe(true);
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('No runs found');
  });

  it('prints the webhook-activity hint when the runs window is empty', async () => {
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      listRuns: async () => ({
        runs: [],
        nextCursor: null,
        prevCursor: null,
        hasMore: false,
        approxTotal: 0,
        pageSize: 20,
      }),
      getWebhookActivity: async () => ({
        windowMinutes: 60,
        received: 3,
        delivered: 3,
        edgeRejected: 0,
        failed: 0,
        matched: 0,
        unmatched: 3,
        orchestratorUnavailable: false,
      }),
    } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await runsListCommand({});
    expect(ok).toBe(true);
    const out = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toMatch(/3 webhooks received in the last hour, 0 matched/);
    expect(out).toMatch(/kici preview push/);
    expect(out).not.toContain('No runs found');
  });

  it('degrades to "none produced a run" when the orchestrator is unavailable', async () => {
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      listRuns: async () => ({
        runs: [],
        nextCursor: null,
        prevCursor: null,
        hasMore: false,
        approxTotal: 0,
        pageSize: 20,
      }),
      getWebhookActivity: async () => ({
        windowMinutes: 60,
        received: 3,
        delivered: 3,
        edgeRejected: 0,
        failed: 0,
        orchestratorUnavailable: true,
      }),
    } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await runsListCommand({});
    expect(ok).toBe(true);
    const out = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toMatch(/3 webhooks received in the last hour but none produced a run/);
    expect(out).not.toMatch(/0 matched/);
  });

  it('degrades silently to "No runs found." when activity is unavailable', async () => {
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      listRuns: async () => ({
        runs: [],
        nextCursor: null,
        prevCursor: null,
        hasMore: false,
        approxTotal: 0,
        pageSize: 20,
      }),
      getWebhookActivity: async () => null,
    } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await runsListCommand({});
    expect(ok).toBe(true);
    const out = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('No runs found.');
    expect(out).not.toMatch(/webhooks received/);
  });

  it('emits raw JSON with --json', async () => {
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      listRuns: async () => ({
        runs: [],
        nextCursor: null,
        prevCursor: null,
        hasMore: false,
        approxTotal: 0,
        pageSize: 20,
      }),
    } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runsListCommand({ json: true });
    expect(log.mock.calls.some((c) => String(c[0]).includes('"runs"'))).toBe(true);
  });
});
