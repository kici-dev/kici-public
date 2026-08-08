import { describe, it, expect, vi } from 'vitest';
import {
  ExecutionJobStatus,
  ExecutionRunStatus,
  TERMINAL_JOB_STATES,
  TERMINAL_RUN_STATES,
} from '@kici-dev/engine';
import { cancelRunWithReason, type CancelRunDeps } from './cancel-run.js';

/**
 * Capture every updateTable(table) call's recorded `.set()` values and `.where()`
 * tuples so tests can assert what cancelRunWithReason wrote. Each updateTable
 * call returns a fresh chain whose terminal `.execute()` resolves to one
 * updated row by default (overridable per table).
 */
function createMockDb(opts?: {
  updatedRowsByTable?: Record<string, bigint>;
  /** Status the run row reports. `null` means "no such run row". */
  runStatus?: string | null;
}) {
  const updates: Array<{ table: string; set: Record<string, unknown>; where: unknown[][] }> = [];
  const deletes: string[] = [];
  const db = {
    selectFrom: vi.fn((_table: string) => {
      const chain: Record<string, any> = {};
      chain.select = vi.fn(() => chain);
      chain.where = vi.fn(() => chain);
      chain.executeTakeFirst = vi.fn(async () =>
        opts?.runStatus === null
          ? undefined
          : { status: opts?.runStatus ?? ExecutionRunStatus.enum.running },
      );
      return chain;
    }),
    deleteFrom: vi.fn((table: string) => {
      deletes.push(table);
      const chain: Record<string, any> = {};
      chain.where = vi.fn(() => chain);
      chain.execute = vi.fn(async () => []);
      return chain;
    }),
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
  return { db: db as unknown as CancelRunDeps['db'], updates, deletes };
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
    // No NOT-IN-TERMINAL orphan sweep, and no immediate completion. Scoped to
    // execution_jobs: the execution_runs writes carry their own NOT-IN-TERMINAL
    // predicate (the lost-race guard) and are expected here.
    const orphanUpdate = mock.updates.find(
      (u) =>
        u.table === 'execution_jobs' && u.where.some((w) => w[0] === 'status' && w[1] === 'not in'),
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

  it.each([
    ExecutionRunStatus.enum.success,
    ExecutionRunStatus.enum.failed,
    ExecutionRunStatus.enum.cancelled,
  ])('short-circuits on an already-terminal run (%s) without writing anything', async (status) => {
    // A cancel racing a run that just finished must not rewrite the finished
    // record. The two execution_runs UPDATEs (cancelled_by, failure_reason) are
    // not status-guarded by themselves, so this short-circuit is what keeps a
    // terminal run's attribution and failure_reason intact.
    const mock = createMockDb({ runStatus: status });
    const { deps, completeSpy } = makeDeps(mock, {
      dispatchedJobIds: ['job-1'],
      agentIdForJob: 'agent-1',
      ws: { send: vi.fn(), readyState: 1 },
    });

    const result = await cancelRunWithReason(deps, 'run-1', 'run cancelled via API', {
      cancelledBy: 'api_key:abc',
    });

    expect(result.alreadyTerminal).toBe(true);
    expect(result.agentsNotified).toBe(0);
    expect(result.pendingCancelled).toBe(0);
    expect(mock.updates).toHaveLength(0);
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it('still cancels a non-terminal run and reports alreadyTerminal false', async () => {
    const mock = createMockDb({ runStatus: ExecutionRunStatus.enum.running });
    const { deps } = makeDeps(mock);

    const result = await cancelRunWithReason(deps, 'run-1', 'run cancelled via API');

    expect(result.alreadyTerminal).toBe(false);
    expect(mock.updates.length).toBeGreaterThan(0);
  });

  it('cancels a run whose row is missing rather than short-circuiting', async () => {
    // A missing row must not read as "already terminal": every entry point
    // answers 404 before reaching here, and the status-guarded UPDATEs below
    // no-op harmlessly on a row that does not exist.
    const mock = createMockDb({ runStatus: null });
    const { deps } = makeDeps(mock);

    const result = await cancelRunWithReason(deps, 'run-1', 'run cancelled via API');

    expect(result.alreadyTerminal).toBe(false);
  });

  it('status-guards both execution_runs writes so a lost race writes nothing', async () => {
    // The short-circuit above is a read-then-write: the run can go terminal
    // between the SELECT and these UPDATEs. Both must carry a status predicate
    // so a cancel that loses that race is a no-op at the database level.
    const mock = createMockDb();
    const { deps } = makeDeps(mock);

    await cancelRunWithReason(deps, 'run-1', 'run cancelled via API', {
      cancelledBy: 'api_key:abc',
    });

    const runWrites = mock.updates.filter((u) => u.table === 'execution_runs');
    expect(runWrites.length).toBe(2);
    for (const write of runWrites) {
      expect(
        write.where.some(
          (w) =>
            w[0] === 'status' &&
            w[1] === 'not in' &&
            Array.isArray(w[2]) &&
            (w[2] as string[]).every((s) => TERMINAL_RUN_STATES.has(s)),
        ),
        `execution_runs write ${JSON.stringify(write.set)} must be status-guarded`,
      ).toBe(true);
    }
  });

  it('never deletes execution_steps rows', async () => {
    // Cancelling must never destroy recorded step history. No delete path
    // exists here today; this pins the invariant so one cannot be introduced.
    const mock = createMockDb();
    const { deps } = makeDeps(mock, {
      dispatchedJobIds: ['job-1'],
      agentIdForJob: 'agent-1',
      ws: { send: vi.fn(), readyState: 1 },
    });

    await cancelRunWithReason(deps, 'run-1', 'run cancelled via API');

    expect(mock.deletes).toEqual([]);
  });
});
