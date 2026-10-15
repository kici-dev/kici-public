import { describe, it, expect, vi } from 'vitest';
import {
  ExecutionJobStatus,
  ExecutionRunStatus,
  TERMINAL_JOB_STATES,
  TERMINAL_RUN_STATES,
} from '@kici-dev/engine';
import { cancelRunWithReason, type CancelRunDeps } from './cancel-run.js';
import { sweepStuckCancelling } from './sweep-stuck-cancelling.js';

/**
 * Records every updateTable(table) call's `.set()` values and `.where()` tuples.
 * Each call returns a fresh chain whose `.execute()` resolves to one updated row
 * by default (overridable per table).
 */
function createMockDb(opts?: {
  updatedRowsByTable?: Record<string, bigint>;
  /** Status the run row reports. `null` means "no such run row". */
  runStatus?: string | null;
  /** Rows a `selectFrom(<table>).…execute()` returns. */
  rows?: Record<string, unknown[]>;
}) {
  const updates: Array<{ table: string; set: Record<string, unknown>; where: unknown[][] }> = [];
  const deletes: string[] = [];
  const db = {
    selectFrom: vi.fn((_table: string) => {
      const chain: Record<string, any> = {};
      chain.select = vi.fn(() => chain);
      chain.where = vi.fn(() => chain);
      chain.orderBy = vi.fn(() => chain);
      chain.limit = vi.fn(() => chain);
      chain.executeTakeFirst = vi.fn(async () =>
        opts?.runStatus === null
          ? undefined
          : { status: opts?.runStatus ?? ExecutionRunStatus.enum.running },
      );
      // `host_roster` (the agent's current coordinator) and `cluster_instances`
      // (live coordinators). Empty by default: the single-coordinator shape.
      chain.execute = vi.fn(async () => opts?.rows?.[_table] ?? []);
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
    /** Dispatch rows as the DB reports them, when a test needs owner detail. */
    dispatchedJobs: Array<{
      jobId: string;
      agentId: string | null;
      ownerInstanceId: string | null;
    }>;
    instanceId: string;
    cancelJobOnPeer: (
      peerId: string,
      runId: string,
      jobId: string,
      reason: string,
      force?: boolean,
    ) => boolean;
  }>,
): {
  deps: CancelRunDeps;
  mock: ReturnType<typeof createMockDb>;
  completeSpy: ReturnType<typeof vi.fn>;
  joblessSpy: ReturnType<typeof vi.fn>;
} {
  const mock = dbOverride ?? createMockDb();
  const completeSpy = vi.fn().mockResolvedValue(undefined);
  const joblessSpy = vi.fn().mockResolvedValue(false);
  const dispatchedJobs =
    over?.dispatchedJobs ??
    (over?.dispatchedJobIds ?? []).map((jobId) => ({
      jobId,
      agentId: over?.agentIdForJob ?? null,
      ownerInstanceId: null,
    }));
  const deps: CancelRunDeps = {
    db: mock.db,
    jobQueue: {
      getDispatchedJobOwnersByRunId: vi.fn().mockResolvedValue(dispatchedJobs),
      cancelByRunId: vi.fn().mockResolvedValue(0),
    } as unknown as CancelRunDeps['jobQueue'],
    registry: {
      get: vi.fn(() => (over && 'ws' in over ? { ws: over.ws } : undefined)),
    } as unknown as CancelRunDeps['registry'],
    executionTracker: {
      completeRunIfAllJobsTerminal: completeSpy,
      cancelJoblessRun: joblessSpy,
    } as unknown as CancelRunDeps['executionTracker'],
    ...(over?.instanceId === undefined ? {} : { instanceId: over.instanceId }),
    ...(over?.cancelJobOnPeer === undefined ? {} : { cancelJobOnPeer: over.cancelJobOnPeer }),
  };
  return { deps, mock, completeSpy, joblessSpy };
}

describe('cancelRunWithReason', () => {
  it('cancels orphaned non-terminal jobs and completes the run when no agent was notified', async () => {
    // A dispatched job whose agent has no live WS — the
    // workflow-timeout-within-1s-of-dispatch race.
    const { deps, mock, completeSpy } = makeDeps(undefined, {
      dispatchedJobIds: ['job-1'],
      agentIdForJob: 'agent-1',
      ws: undefined, // no live WS → agentsNotified stays 0
    });

    const result = await cancelRunWithReason(deps, 'run-1', 'workflow_timeout: ...');

    expect(result.agentsNotified).toBe(0);

    // The orphan-cancel UPDATE carries a NOT-IN TERMINAL_JOB_STATES guard so a
    // dispatched/running row gets cancelled.
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
    // A live, OPEN agent WS → agentsNotified increments, and the agent's later
    // job.complete drives the run terminal, not this call.
    const { deps, mock, completeSpy } = makeDeps(undefined, {
      dispatchedJobIds: ['job-1'],
      agentIdForJob: 'agent-1',
      ws: { send: vi.fn(), readyState: 1 },
    });

    const result = await cancelRunWithReason(deps, 'run-1', 'workflow_timeout: ...');

    expect(result.agentsNotified).toBe(1);
    // No orphan sweep over execution_jobs and no immediate completion. The
    // execution_runs writes carry their own NOT-IN-TERMINAL predicate (the
    // lost-race guard) and are expected.
    const orphanUpdate = mock.updates.find(
      (u) =>
        u.table === 'execution_jobs' && u.where.some((w) => w[0] === 'status' && w[1] === 'not in'),
    );
    expect(orphanUpdate).toBeUndefined();
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it('leaves a notified job out of the pending/queued sweep', async () => {
    // A dispatched job reads `queued` until its agent's first frame, so the queue
    // sweep can reach a job an agent is unwinding. Cancelling it would record a
    // terminal verdict for in-flight work, and since `execution_jobs` writes are
    // monotonic the agent's own terminal frame would be rejected, its run-completion
    // fan-out would never fire, and the run would be stranded in `running`.
    const { deps, mock } = makeDeps(undefined, {
      dispatchedJobIds: ['job-1'],
      agentIdForJob: 'agent-1',
      ws: { send: vi.fn(), readyState: 1 },
    });

    const result = await cancelRunWithReason(deps, 'run-1', 'run cancelled via API');

    expect(result.agentsNotified).toBe(1);
    const queueSweep = mock.updates.find(
      (u) =>
        u.table === 'execution_jobs' &&
        u.where.some(
          (w) =>
            w[0] === 'status' &&
            w[1] === 'in' &&
            Array.isArray(w[2]) &&
            (w[2] as string[]).includes(ExecutionJobStatus.enum.queued),
        ),
    );
    expect(queueSweep).toBeDefined();
    expect(queueSweep?.where).toContainEqual(['job_id', 'not in', ['job-1']]);
  });

  it('leaves an unreachable job out of the pending/queued sweep', async () => {
    // The owner is alive, so the job is not an orphan and the re-drive sweep will
    // retry; recording it cancelled would be a terminal verdict for a running job.
    const mockDb = createMockDb({ rows: { cluster_instances: [{ instance_id: 'coord-b' }] } });
    const { deps, mock } = makeDeps(mockDb, {
      dispatchedJobs: [{ jobId: 'job-1', agentId: 'agent-1', ownerInstanceId: 'coord-b' }],
      instanceId: 'coord-a',
      cancelJobOnPeer: () => false,
    });

    const result = await cancelRunWithReason(deps, 'run-1', 'run cancelled via API');

    expect(result.unreachable).toBe(1);
    const queueSweep = mock.updates.find(
      (u) =>
        u.table === 'execution_jobs' &&
        u.where.some(
          (w) =>
            w[0] === 'status' &&
            w[1] === 'in' &&
            Array.isArray(w[2]) &&
            (w[2] as string[]).includes(ExecutionJobStatus.enum.queued),
        ),
    );
    expect(queueSweep?.where).toContainEqual(['job_id', 'not in', ['job-1']]);
  });

  it('forwards force to the coordinator that owns a sibling job', async () => {
    // The sibling reads live through its `cluster_instances` row, as in the
    // 'moves the run to cancelling…' case; otherwise no forward is attempted.
    const mockDb = createMockDb({ rows: { cluster_instances: [{ instance_id: 'coord-b' }] } });
    const forward = vi.fn().mockReturnValue(true);
    const { deps } = makeDeps(mockDb, {
      dispatchedJobs: [{ jobId: 'job-1', agentId: 'agent-1', ownerInstanceId: 'coord-b' }],
      instanceId: 'coord-a',
      cancelJobOnPeer: forward,
    });

    const result = await cancelRunWithReason(deps, 'run-1', 'force cancelled via API', {
      force: true,
    });

    expect(result.agentsNotified).toBe(1);
    // fails-when: the forward drops force and the sibling cancels gracefully.
    expect(forward).toHaveBeenCalledWith(
      'coord-b',
      'run-1',
      'job-1',
      'force cancelled via API',
      true,
    );
  });

  describe('a forced cancel whose forward fails', () => {
    /**
     * The live sibling owner is unreachable, so the first forward fails and the run
     * stays `cancelling`. The sweep reads it back with what the first cancel stamped
     * and re-drives through the real cancel path.
     */
    async function cancelThenSweep(force: boolean) {
      const forward = vi.fn().mockReturnValue(false);
      const mockDb = createMockDb({ rows: { cluster_instances: [{ instance_id: 'coord-b' }] } });
      const { deps, mock } = makeDeps(mockDb, {
        dispatchedJobs: [{ jobId: 'job-1', agentId: 'agent-1', ownerInstanceId: 'coord-b' }],
        instanceId: 'coord-a',
        cancelJobOnPeer: forward,
      });

      const first = await cancelRunWithReason(deps, 'run-1', 'cancel', { force });
      expect(first.unreachable).toBe(1);
      const stamped = mock.updates.some(
        (u) => u.table === 'execution_runs' && u.set.cancel_force === true,
      );
      // The sweep reads the stuck run back with what the first cancel wrote.
      const sweepDb = createMockDb({
        rows: { execution_runs: [{ run_id: 'run-1', cancel_force: stamped ? true : null }] },
      });

      forward.mockClear();
      await sweepStuckCancelling({
        db: sweepDb.db,
        cancelRun: (runId, reason, options) => cancelRunWithReason(deps, runId, reason, options),
        stuckAfterMs: 0,
      });
      return { stamped, forward };
    }

    it('stamps cancel_force, and the sweep re-sends the cancel forced', async () => {
      const { stamped, forward } = await cancelThenSweep(true);

      // fails-when: force is not recorded, or the sweep re-sends without it —
      // the sibling then runs the job's graceful hooks the operator skipped.
      expect(stamped).toBe(true);
      expect(forward).toHaveBeenCalledWith(
        'coord-b',
        'run-1',
        'job-1',
        'run cancelled (re-driven: cancel did not complete)',
        true,
      );
    });

    it('leaves a graceful cancel graceful on the re-drive', async () => {
      const { stamped, forward } = await cancelThenSweep(false);

      // breaks-if-wrong: a graceful cancel must not be escalated by the sweep.
      expect(stamped).toBe(false);
      expect(forward).toHaveBeenCalledWith(
        'coord-b',
        'run-1',
        'job-1',
        'run cancelled (re-driven: cancel did not complete)',
        false,
      );
    });
  });

  it('moves the run to cancelling when the owning coordinator is live but unreachable', async () => {
    // The job belongs to a live sibling and the peer forward fails. It is not an
    // orphan (its agent is likely still running it), so nothing is marked terminal.
    // The cancel still leaves a durable `cancelling` stamp: no agent will report
    // `cancelling` for a cancel that never arrived, and the stuck-cancelling
    // re-drive selects on it, so without the stamp the cancel is silently dropped.
    const mockDb = createMockDb({ rows: { cluster_instances: [{ instance_id: 'coord-b' }] } });
    const { deps, mock, completeSpy } = makeDeps(mockDb, {
      dispatchedJobs: [{ jobId: 'job-1', agentId: 'agent-1', ownerInstanceId: 'coord-b' }],
      instanceId: 'coord-a',
      cancelJobOnPeer: () => false,
    });

    const result = await cancelRunWithReason(deps, 'run-1', 'run cancelled via API');

    expect(result.agentsNotified).toBe(0);
    expect(result.unreachable).toBe(1);

    const cancellingUpdate = mock.updates.find(
      (u) => u.table === 'execution_runs' && u.set.status === ExecutionRunStatus.enum.cancelling,
    );
    expect(cancellingUpdate).toBeDefined();
    expect(cancellingUpdate?.set.cancelling_at).toBeInstanceOf(Date);

    // Nothing terminal: no orphan sweep over execution_jobs, no run completion.
    const orphanUpdate = mock.updates.find(
      (u) =>
        u.table === 'execution_jobs' && u.where.some((w) => w[0] === 'status' && w[1] === 'not in'),
    );
    expect(orphanUpdate).toBeUndefined();
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it('treats a non-OPEN (mid-close) socket as orphaned and completes the run', async () => {
    // The agent is registered but its socket is CLOSING (readyState 2). Sending
    // would throw, so the loop skips it, agentsNotified stays 0, and the orphan
    // sweep drives the run terminal.
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
    // readyState reads OPEN but send() throws (socket closed between check and
    // send). The throw is swallowed: the run is still fully cancelled (reason
    // stamped) and the job counts as orphaned.
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
    // record. The cancelled_by / failure_reason UPDATEs are not status-guarded by
    // themselves, so this short-circuit keeps a terminal run's attribution and
    // failure_reason intact.
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
    // A missing row must not read as "already terminal": every entry point answers
    // 404 first, and the status-guarded UPDATEs no-op on a missing row.
    const mock = createMockDb({ runStatus: null });
    const { deps } = makeDeps(mock);

    const result = await cancelRunWithReason(deps, 'run-1', 'run cancelled via API');

    expect(result.alreadyTerminal).toBe(false);
  });

  it('status-guards both execution_runs writes so a lost race writes nothing', async () => {
    // The short-circuit is a read-then-write: the run can go terminal between the
    // SELECT and these UPDATEs, so both carry a status predicate and a lost race is
    // a DB-level no-op.
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
    // Cancelling must never destroy recorded step history; this pins the invariant
    // so no delete path can be introduced.
    const mock = createMockDb();
    const { deps } = makeDeps(mock, {
      dispatchedJobIds: ['job-1'],
      agentIdForJob: 'agent-1',
      ws: { send: vi.fn(), readyState: 1 },
    });

    await cancelRunWithReason(deps, 'run-1', 'run cancelled via API');

    expect(mock.deletes).toEqual([]);
  });

  describe('a run with no job rows', () => {
    it('terminalizes a jobless pending run itself, after the job-driven completion', async () => {
      // No job will ever report a terminal status for it, so without this the
      // cancel answers "cancelled" while the row keeps `pending`.
      // fails-when: a cancelled run with no jobs keeps its non-terminal status
      const { deps, completeSpy, joblessSpy } = makeDeps(
        createMockDb({ runStatus: ExecutionRunStatus.enum.pending }),
      );

      const result = await cancelRunWithReason(deps, 'run-jobless', 'cancelled by a user');

      expect(result.alreadyTerminal).toBe(false);
      expect(joblessSpy).toHaveBeenCalledWith('run-jobless', 'cancelled by a user');
      expect(joblessSpy.mock.invocationCallOrder[0]).toBeGreaterThan(
        completeSpy.mock.invocationCallOrder[0]!,
      );
    });

    it('leaves a run whose jobs an agent is unwinding to those jobs', async () => {
      // breaks-if-wrong: a run with a live job must still be driven terminal by the job, as before
      const sent: unknown[] = [];
      const { deps, completeSpy, joblessSpy } = makeDeps(undefined, {
        dispatchedJobIds: ['job-1'],
        agentIdForJob: 'agent-1',
        ws: { readyState: 1, send: (m: unknown) => sent.push(m) },
      });

      const result = await cancelRunWithReason(deps, 'run-with-jobs', 'cancelled by a user');

      expect(result.agentsNotified).toBe(1);
      expect(completeSpy).not.toHaveBeenCalled();
      expect(joblessSpy).not.toHaveBeenCalled();
    });
  });
});
