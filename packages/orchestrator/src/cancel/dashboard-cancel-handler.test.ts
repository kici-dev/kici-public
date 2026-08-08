import { describe, it, expect, vi } from 'vitest';
import { ExecutionRunStatus } from '@kici-dev/engine';
import { createDashboardCancelHandler } from './dashboard-cancel-handler.js';
import type { CancelRunDeps } from './cancel-run.js';

function makeDeps(over?: { runStatus?: string; dispatchedJobIds?: string[]; ws?: unknown }): {
  deps: CancelRunDeps;
  cancelByRunId: ReturnType<typeof vi.fn>;
  updates: string[];
  send: ReturnType<typeof vi.fn> | undefined;
} {
  const updates: string[] = [];
  const cancelByRunId = vi.fn().mockResolvedValue(0);
  const db = {
    selectFrom: vi.fn(() => {
      const chain: Record<string, any> = {};
      chain.select = vi.fn(() => chain);
      chain.where = vi.fn(() => chain);
      chain.executeTakeFirst = vi.fn(async () => ({
        status: over?.runStatus ?? ExecutionRunStatus.enum.running,
      }));
      return chain;
    }),
    updateTable: vi.fn((table: string) => {
      updates.push(table);
      const chain: Record<string, any> = {};
      chain.set = vi.fn(() => chain);
      chain.where = vi.fn(() => chain);
      chain.execute = vi.fn(async () => [{ numUpdatedRows: 1n }]);
      return chain;
    }),
  };
  const entry = over && 'ws' in over ? { ws: over.ws } : undefined;
  const deps = {
    db: db as unknown as CancelRunDeps['db'],
    jobQueue: {
      getDispatchedJobIdsByRunId: vi.fn().mockResolvedValue(over?.dispatchedJobIds ?? []),
      cancelByRunId,
    } as unknown as CancelRunDeps['jobQueue'],
    dispatcher: {
      getAgentIdForJob: vi.fn(() => 'agent-1'),
    } as unknown as CancelRunDeps['dispatcher'],
    registry: {
      get: vi.fn(() => entry),
    } as unknown as CancelRunDeps['registry'],
    executionTracker: {
      completeRunIfAllJobsTerminal: vi.fn().mockResolvedValue(undefined),
    } as unknown as CancelRunDeps['executionTracker'],
  };
  const ws = entry?.ws as { send?: ReturnType<typeof vi.fn> } | undefined;
  return { deps, cancelByRunId, updates, send: ws?.send };
}

describe('createDashboardCancelHandler', () => {
  it('reports alreadyTerminal and writes nothing for a finished run', async () => {
    const { deps, cancelByRunId, updates } = makeDeps({
      runStatus: ExecutionRunStatus.enum.success,
    });
    const onCancel = createDashboardCancelHandler(deps);

    const result = await onCancel('run-1', 'user:alice', null, false);

    expect(result.alreadyTerminal).toBe(true);
    expect(result.cancelledJobs).toBe(0);
    expect(updates).toEqual([]);
    expect(cancelByRunId).not.toHaveBeenCalled();
  });

  it('cancels queued dispatch rows for a live run', async () => {
    // The inline path this replaces never called cancelByRunId, so a queued job
    // could still dispatch after a "successful" cancel.
    const { deps, cancelByRunId } = makeDeps();
    const onCancel = createDashboardCancelHandler(deps);

    const result = await onCancel('run-1', 'user:alice', null, false);

    expect(result.alreadyTerminal).toBe(false);
    expect(cancelByRunId).toHaveBeenCalledWith('run-1');
  });

  it('skips a mid-close socket instead of aborting the cancellation', async () => {
    // The inline path this replaces sent without a readyState check, so one
    // closing socket threw and skipped every remaining job.
    const send = vi.fn(() => {
      throw new Error('WebSocket is not open');
    });
    const { deps, cancelByRunId } = makeDeps({
      dispatchedJobIds: ['job-1'],
      ws: { send, readyState: 2 /* CLOSING */ },
    });
    const onCancel = createDashboardCancelHandler(deps);

    const result = await onCancel('run-1', null, null, false);

    expect(send).not.toHaveBeenCalled();
    expect(result.alreadyTerminal).toBe(false);
    expect(cancelByRunId).toHaveBeenCalledWith('run-1');
  });

  it('builds the dashboard reason when no canceller is attributed', async () => {
    const { deps, send } = makeDeps({
      dispatchedJobIds: ['job-1'],
      ws: { send: vi.fn(), readyState: 1 },
    });
    const onCancel = createDashboardCancelHandler(deps);

    await onCancel('run-1', null, null, false);

    const sent = JSON.parse(String(send!.mock.calls[0]![0]));
    expect(sent.reason).toBe('run cancelled via dashboard');
    expect(sent.type).toBe('job.cancel');
  });

  it('attributes the canceller in the reason when one is given', async () => {
    const { deps, send } = makeDeps({
      dispatchedJobIds: ['job-1'],
      ws: { send: vi.fn(), readyState: 1 },
    });
    const onCancel = createDashboardCancelHandler(deps);

    const result = await onCancel('run-1', 'user:alice', 'agent-label', true);

    const sent = JSON.parse(String(send!.mock.calls[0]![0]));
    expect(sent.reason).toBe('run cancelled by user:alice');
    expect(sent.force).toBe(true);
    // cancelledJobs is agentsNotified + pendingCancelled, matching the operator
    // route — the inline path it replaces counted notified agents only.
    expect(result.cancelledJobs).toBe(2);
  });
});
