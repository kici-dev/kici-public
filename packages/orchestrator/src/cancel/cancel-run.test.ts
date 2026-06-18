import { describe, it, expect, vi } from 'vitest';
import { ExecutionJobStatus, TERMINAL_JOB_STATES } from '@kici-dev/engine';
import { cancelRunWithReason, type CancelRunDeps } from './cancel-run.js';

/**
 * Capture every updateTable(table) call's recorded `.set()` values and `.where()`
 * tuples so tests can assert what cancelRunWithReason wrote. Each updateTable
 * call returns a fresh chain whose terminal `.execute()` resolves to one
 * updated row by default (overridable per table).
 */
function createMockDb(opts?: { updatedRowsByTable?: Record<string, bigint> }) {
  const updates: Array<{ table: string; set: Record<string, unknown>; where: unknown[][] }> = [];
  const db = {
    updateTable: vi.fn((table: string) => {
      const record = { table, set: {} as Record<string, unknown>, where: [] as unknown[][] };
      updates.push(record);
      const chain: Record<string, any> = {};
      chain.set = vi.fn((vals: Record<string, unknown>) => {
        record.set = vals;
        return chain;
      });
      chain.where = vi.fn((...args: unknown[]) => {
        record.where.push(args);
        return chain;
      });
      chain.execute = vi.fn(async () => {
        const n = opts?.updatedRowsByTable?.[table] ?? 1n;
        return [{ numUpdatedRows: n }];
      });
      return chain;
    }),
  };
  return { db: db as unknown as CancelRunDeps['db'], updates };
}

function makeDeps(
  dbOverride?: ReturnType<typeof createMockDb>,
  over?: Partial<{
    dispatchedJobIds: string[];
    agentIdForJob: string | null;
    ws: unknown;
  }>,
): {
  deps: CancelRunDeps;
  mock: ReturnType<typeof createMockDb>;
  completeSpy: ReturnType<typeof vi.fn>;
} {
  const mock = dbOverride ?? createMockDb();
  const completeSpy = vi.fn().mockResolvedValue(undefined);
  const deps: CancelRunDeps = {
    db: mock.db,
    jobQueue: {
      getDispatchedJobIdsByRunId: vi.fn().mockResolvedValue(over?.dispatchedJobIds ?? []),
      cancelByRunId: vi.fn().mockResolvedValue(0),
    } as unknown as CancelRunDeps['jobQueue'],
    dispatcher: {
      getAgentIdForJob: vi.fn(() => over?.agentIdForJob ?? null),
    } as unknown as CancelRunDeps['dispatcher'],
    registry: {
      get: vi.fn(() => (over && 'ws' in over ? { ws: over.ws } : undefined)),
    } as unknown as CancelRunDeps['registry'],
    executionTracker: {
      completeRunIfAllJobsTerminal: completeSpy,
    } as unknown as CancelRunDeps['executionTracker'],
  };
  return { deps, mock, completeSpy };
}

describe('cancelRunWithReason', () => {
  it('cancels orphaned non-terminal jobs and completes the run when no agent was notified', async () => {
    // A job is dispatched (so getDispatchedJobIdsByRunId returns it) but its
    // agent has no live WS — the workflow-timeout-within-1s-of-dispatch race.
    const { deps, mock, completeSpy } = makeDeps(undefined, {
      dispatchedJobIds: ['job-1'],
      agentIdForJob: 'agent-1',
      ws: undefined, // no live WS → agentsNotified stays 0
    });

    const result = await cancelRunWithReason(deps, 'run-1', 'workflow_timeout: ...');

    expect(result.agentsNotified).toBe(0);

    // The orphan-cancel UPDATE targets execution_jobs with a NOT-IN
    // TERMINAL_JOB_STATES guard so a dispatched/running row gets cancelled.
    const orphanUpdate = mock.updates.find(
      (u) =>
        u.table === 'execution_jobs' &&
        u.set.status === ExecutionJobStatus.enum.cancelled &&
        u.where.some(
          (w) =>
            w[0] === 'status' &&
            w[1] === 'not in' &&
            Array.isArray(w[2]) &&
            (w[2] as string[]).every((s) => TERMINAL_JOB_STATES.has(s)),
        ),
    );
    expect(orphanUpdate).toBeDefined();

    // With no agent to wait on, the run is driven terminal immediately.
    expect(completeSpy).toHaveBeenCalledWith('run-1');
  });

  it('does NOT orphan-cancel running jobs when an agent was notified', async () => {
    // A live, OPEN agent WS exists → agentsNotified increments, the run will be
    // driven terminal by the agent's later job.complete, not here.
    const { deps, mock, completeSpy } = makeDeps(undefined, {
      dispatchedJobIds: ['job-1'],
      agentIdForJob: 'agent-1',
      ws: { send: vi.fn(), readyState: 1 },
    });

    const result = await cancelRunWithReason(deps, 'run-1', 'workflow_timeout: ...');

    expect(result.agentsNotified).toBe(1);
    // No NOT-IN-TERMINAL orphan sweep, and no immediate completion.
    const orphanUpdate = mock.updates.find((u) =>
      u.where.some((w) => w[0] === 'status' && w[1] === 'not in'),
    );
    expect(orphanUpdate).toBeUndefined();
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it('treats a non-OPEN (mid-close) socket as orphaned and completes the run', async () => {
    // The agent is still in the registry but its socket is CLOSING (readyState
    // 2). Sending to it would throw; the loop must skip it, leave agentsNotified
    // at 0, and fall into the orphan sweep so the run is driven terminal.
    const send = vi.fn();
    const { deps, completeSpy } = makeDeps(undefined, {
      dispatchedJobIds: ['job-1'],
      agentIdForJob: 'agent-1',
      ws: { send, readyState: 2 /* CLOSING */ },
    });

    const result = await cancelRunWithReason(deps, 'run-1', 'workflow_timeout: ...');

    expect(send).not.toHaveBeenCalled();
    expect(result.agentsNotified).toBe(0);
    expect(completeSpy).toHaveBeenCalledWith('run-1');
  });

  it('does not abort the cancellation when a send throws', async () => {
    // readyState reads OPEN but send() throws (socket raced to closed between
    // the check and the send). The throw must be swallowed: the run is still
    // fully cancelled (reason stamped) and the job counts as orphaned.
    const send = vi.fn(() => {
      throw new Error('WebSocket is not open');
    });
    const { deps, mock, completeSpy } = makeDeps(undefined, {
      dispatchedJobIds: ['job-1'],
      agentIdForJob: 'agent-1',
      ws: { send, readyState: 1 /* OPEN */ },
    });

    const result = await cancelRunWithReason(deps, 'run-1', 'workflow_timeout: boom');

    expect(send).toHaveBeenCalledTimes(1);
    expect(result.agentsNotified).toBe(0);
    // The reason is still stamped despite the send throwing.
    const reasonUpdate = mock.updates.find(
      (u) => u.table === 'execution_runs' && u.set.failure_reason === 'workflow_timeout: boom',
    );
    expect(reasonUpdate).toBeDefined();
    // With no successful notification, the run is driven terminal here.
    expect(completeSpy).toHaveBeenCalledWith('run-1');
  });

  it('stamps the reason guarded by failure_reason IS NULL', async () => {
    const { deps, mock } = makeDeps();
    await cancelRunWithReason(deps, 'run-1', 'workflow_timeout: boom');
    const reasonUpdate = mock.updates.find(
      (u) =>
        u.table === 'execution_runs' &&
        u.set.failure_reason === 'workflow_timeout: boom' &&
        u.where.some((w) => w[0] === 'failure_reason' && w[1] === 'is' && w[2] === null),
    );
    expect(reasonUpdate).toBeDefined();
  });
});
