import { describe, it, expect, vi, afterEach } from 'vitest';
import { logger } from '@kici-dev/core';
import { runsRerunCommand } from './rerun.js';
import * as clientMod from '../../remote/dashboard-client.js';

afterEach(() => vi.restoreAllMocks());

/** A run id the commands accept as a full id. */
const RUN = '0f1e2d3c-0000-4000-8000-000000000001';

function stubClient(client: Record<string, unknown>): void {
  vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue(client as never);
}

function printed(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((c) => String(c[0])).join('\n');
}

describe('runsRerunCommand', () => {
  it('reports the new run id and how to follow it', async () => {
    const rerunRun = vi.fn(async () => ({ newRunId: 'r2' }));
    stubClient({ rerunRun });
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await runsRerunCommand(RUN, {});
    expect(ok).toBe(true);
    expect(rerunRun).toHaveBeenCalledWith(RUN);
    expect(printed(info)).toContain('r2');
    expect(printed(info)).toContain('kici runs show r2');
  });

  it('prints only the new run id with --json', async () => {
    stubClient({ rerunRun: async () => ({ newRunId: 'r2' }) });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runsRerunCommand(RUN, { json: true })).toBe(true);
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual({ newRunId: 'r2' });
  });

  it('says when an earlier request already queued the rerun', async () => {
    stubClient({ rerunRun: async () => ({ newRunId: 'r2', alreadyAccepted: true }) });
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runsRerunCommand(RUN, {})).toBe(true);
    // fails-when: the flag is dropped and the retry reads as a new rerun
    expect(printed(info)).toContain('Rerun already queued by an earlier request: ');
    expect(printed(info)).toContain('kici runs show r2');
  });

  it('keeps the plain line without the flag, and prints the flag with --json', async () => {
    stubClient({ rerunRun: async () => ({ newRunId: 'r2' }) });
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runsRerunCommand(RUN, {});
    expect(printed(info)).toContain('Rerun queued: ');
    expect(printed(info)).not.toContain('already queued');

    info.mockClear();
    stubClient({ rerunRun: async () => ({ newRunId: 'r2', alreadyAccepted: true }) });
    await runsRerunCommand(RUN, { json: true });
    expect(JSON.parse(String(info.mock.calls[0]![0]))).toEqual({
      newRunId: 'r2',
      alreadyAccepted: true,
    });
  });

  it('reruns the run a unique short id names', async () => {
    const rerunRun = vi.fn(async () => ({ newRunId: 'r2' }));
    stubClient({ rerunRun, listRuns: async () => ({ runs: [{ runId: RUN }], hasMore: false }) });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // fails-when: the short id is sent as a run id, and the Platform answers "Run not found"
    expect(await runsRerunCommand('0f1e2d3c', {})).toBe(true);
    expect(rerunRun).toHaveBeenCalledWith(RUN);
  });

  it('makes no lookup for a full run id', async () => {
    const listRuns = vi.fn();
    stubClient({ rerunRun: async () => ({ newRunId: 'r2' }), listRuns });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runsRerunCommand(RUN, {})).toBe(true);
    expect(listRuns).not.toHaveBeenCalled();
  });

  it.each([
    ['the unconfirmed-start body', 'run_start_unconfirmed'],
    ['the plain timeout of an older Platform', 'Orchestrator did not respond in time'],
  ])('reports a timeout with %s as unconfirmed, not failed', async (_label, message) => {
    stubClient({
      rerunRun: async () => {
        throw new clientMod.DashboardClientError('orchestrator_offline', message, 504);
      },
    });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const err = vi.spyOn(logger, 'error').mockImplementation(() => logger);

    // fails-when: the timeout is logged as an error, which reads as a failed rerun
    expect(await runsRerunCommand(RUN, {})).toBe(false);
    expect(err).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    const text = String(warn.mock.calls[0]![0]);
    expect(text).toContain(`Could not confirm that the rerun of ${RUN}`);
    expect(text).toContain('may still start');
    expect(text).toContain('kici runs list --trigger rerun --since 20');
  });

  it('surfaces a cooldown error clearly', async () => {
    stubClient({
      rerunRun: async () => {
        throw new clientMod.DashboardClientError('cooldown', 'Wait 5s.', 429);
      },
    });
    const err = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    // breaks-if-wrong: a definite refusal still reads as an error
    const ok = await runsRerunCommand(RUN, {});
    expect(ok).toBe(false);
    expect(err).toHaveBeenCalled();
  });
});
