import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCleanup } from './cleanup.js';
import type { JobQueue, ExpiredJobInfo } from './job-queue.js';
import type { ExecutionTracker } from '../reporting/execution-tracker.js';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';

function createMockDedup(deleted = 0) {
  return { cleanup: vi.fn().mockResolvedValue(deleted) };
}

function createMockQueue(expiredJobs: ExpiredJobInfo[] = []) {
  return { markExpired: vi.fn().mockResolvedValue(expiredJobs) } as unknown as JobQueue;
}

function createMockExtras() {
  const updateExecuteTakeFirst = vi.fn().mockResolvedValue({ numUpdatedRows: 1n });
  const selectExecuteTakeFirst = vi.fn().mockResolvedValue({ job_id: 'j-1' });

  // Records each execution_runs UPDATE's `.set(...)` payload + the `.where(...)`
  // arg tuples so tests can assert when (and with what) the run-level
  // failure_reason was written, and that the NULL clobber-guard is applied.
  const runSetCalls: Array<Record<string, unknown>> = [];
  const runWhereCalls: unknown[][] = [];
  const runUpdateExecute = vi.fn().mockResolvedValue([{ numUpdatedRows: 1n }]);

  // A `.set().where().where().execute()` chain for the execution_runs update.
  const recordWhere = vi.fn((...args: unknown[]) => {
    runWhereCalls.push(args);
    return whereChain;
  });
  const whereChain = { where: recordWhere, execute: runUpdateExecute };
  const runUpdateChain = {
    set: vi.fn((payload: Record<string, unknown>) => {
      runSetCalls.push(payload);
      return whereChain;
    }),
  };

  // The execution_jobs `.set().where().where().where().executeTakeFirst()` chain.
  const jobUpdateChain = {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            executeTakeFirst: updateExecuteTakeFirst,
          }),
        }),
      }),
    }),
  };

  const updateTable = vi.fn((table: string) =>
    table === 'execution_runs' ? runUpdateChain : jobUpdateChain,
  );

  const db = {
    updateTable,
    selectFrom: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            executeTakeFirst: selectExecuteTakeFirst,
          }),
        }),
      }),
    }),
  } as unknown as Kysely<Database>;

  const executionTracker = {
    updateInMemoryJob: vi.fn(),
    forwardJobTerminalStatus: vi.fn(),
    emitInfraEvent: vi.fn(),
    completeRunIfAllJobsTerminal: vi.fn().mockResolvedValue(undefined),
  } as unknown as ExecutionTracker;

  return {
    db,
    executionTracker,
    _mocks: {
      updateExecuteTakeFirst,
      selectExecuteTakeFirst,
      runSetCalls,
      runWhereCalls,
      runUpdateExecute,
    },
  };
}

describe('runCleanup', () => {
  it('calls dedup.cleanup and queue.markExpired', async () => {
    const dedup = createMockDedup(5);
    const queue = createMockQueue([]);

    const result = await runCleanup(dedup, queue);

    expect(dedup.cleanup).toHaveBeenCalled();
    expect(queue.markExpired).toHaveBeenCalled();
    expect(result).toEqual({
      dedupDeleted: 5,
      queueExpired: 0,
    });
  });

  it('returns expired count from markExpired array length', async () => {
    const expired: ExpiredJobInfo[] = [
      { id: 'q-1', runId: 'run-1', jobName: 'build', lastProvisioningError: null },
      { id: 'q-2', runId: 'run-2', jobName: 'test', lastProvisioningError: null },
    ];
    const dedup = createMockDedup(0);
    const queue = createMockQueue(expired);

    const result = await runCleanup(dedup, queue);

    expect(result).toEqual({
      dedupDeleted: 0,
      queueExpired: 2,
    });
  });

  it('skips Platform forwarding when extras is not provided', async () => {
    const expired: ExpiredJobInfo[] = [
      { id: 'q-1', runId: 'run-1', jobName: 'build', lastProvisioningError: null },
    ];
    const dedup = createMockDedup(0);
    const queue = createMockQueue(expired);

    // No extras -- independent mode
    const result = await runCleanup(dedup, queue);

    expect(result.queueExpired).toBe(1);
    // No errors, no forwarding attempts
  });

  it('forwards expired jobs to Platform when extras is provided', async () => {
    const expired: ExpiredJobInfo[] = [
      { id: 'q-1', runId: 'run-1', jobName: 'build', lastProvisioningError: null },
    ];
    const dedup = createMockDedup(0);
    const queue = createMockQueue(expired);
    const { db, executionTracker } = createMockExtras();

    await runCleanup(dedup, queue, { db, executionTracker });

    expect(executionTracker.updateInMemoryJob).toHaveBeenCalledWith(
      'run-1',
      'j-1',
      'timed_out_stale',
    );
    expect(executionTracker.forwardJobTerminalStatus).toHaveBeenCalledWith(
      'run-1',
      'j-1',
      'build',
      'timed_out_stale',
      'Queue timeout expired (job was never dispatched to an agent)',
    );
    expect(executionTracker.emitInfraEvent).toHaveBeenCalledWith(
      'run-1',
      'orchestrator.job.queue_expired',
      expect.objectContaining({ jobId: 'j-1' }),
    );
    expect(executionTracker.completeRunIfAllJobsTerminal).toHaveBeenCalledWith('run-1');
  });

  it('deduplicates run completion checks across jobs in the same run', async () => {
    const expired: ExpiredJobInfo[] = [
      { id: 'q-1', runId: 'run-1', jobName: 'build', lastProvisioningError: null },
      { id: 'q-2', runId: 'run-1', jobName: 'test', lastProvisioningError: null },
    ];
    const dedup = createMockDedup(0);
    const queue = createMockQueue(expired);
    const { db, executionTracker } = createMockExtras();

    await runCleanup(dedup, queue, { db, executionTracker });

    // Should forward for both jobs
    expect(executionTracker.forwardJobTerminalStatus).toHaveBeenCalledTimes(2);
    // But only check run completion once (dedup by runId)
    expect(executionTracker.completeRunIfAllJobsTerminal).toHaveBeenCalledTimes(1);
    expect(executionTracker.completeRunIfAllJobsTerminal).toHaveBeenCalledWith('run-1');
  });

  it('skips forwarding when execution_jobs update affects 0 rows', async () => {
    const expired: ExpiredJobInfo[] = [
      { id: 'q-1', runId: 'run-1', jobName: 'build', lastProvisioningError: null },
    ];
    const dedup = createMockDedup(0);
    const queue = createMockQueue(expired);
    const extras = createMockExtras();
    // Simulate no rows updated (job already terminal or doesn't exist in execution_jobs)
    extras._mocks.updateExecuteTakeFirst.mockResolvedValue({ numUpdatedRows: 0n });

    await runCleanup(dedup, queue, { db: extras.db, executionTracker: extras.executionTracker });

    expect(extras.executionTracker.forwardJobTerminalStatus).not.toHaveBeenCalled();
    expect(extras.executionTracker.completeRunIfAllJobsTerminal).not.toHaveBeenCalled();
  });

  it('continues processing other jobs when one fails', async () => {
    const expired: ExpiredJobInfo[] = [
      { id: 'q-1', runId: 'run-1', jobName: 'build', lastProvisioningError: null },
      { id: 'q-2', runId: 'run-2', jobName: 'test', lastProvisioningError: null },
    ];
    const dedup = createMockDedup(0);
    const queue = createMockQueue(expired);
    const extras = createMockExtras();

    let callCount = 0;
    (extras.db.updateTable as any).mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error('DB error');
      return {
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                executeTakeFirst: vi.fn().mockResolvedValue({ numUpdatedRows: 1n }),
              }),
            }),
          }),
        }),
      };
    });

    // Should not throw — error is caught and logged
    const result = await runCleanup(dedup, queue, {
      db: extras.db,
      executionTracker: extras.executionTracker,
    });

    expect(result.queueExpired).toBe(2);
  });

  it('uses the provisioning error as the job error_message and run failure_reason', async () => {
    const provisioningError = 'Container scaler: image pull failed (manifest unknown)';
    const expired: ExpiredJobInfo[] = [
      { id: 'q-1', runId: 'run-1', jobName: 'build', lastProvisioningError: provisioningError },
    ];
    const dedup = createMockDedup(0);
    const queue = createMockQueue(expired);
    const extras = createMockExtras();

    await runCleanup(dedup, queue, { db: extras.db, executionTracker: extras.executionTracker });

    // The forwarded terminal status carries the provisioning error, not the generic message.
    expect(extras.executionTracker.forwardJobTerminalStatus).toHaveBeenCalledWith(
      'run-1',
      'j-1',
      'build',
      'timed_out_stale',
      provisioningError,
    );
    expect(extras.executionTracker.emitInfraEvent).toHaveBeenCalledWith(
      'run-1',
      'orchestrator.job.queue_expired',
      expect.objectContaining({ metadata: expect.objectContaining({ reason: provisioningError }) }),
    );
    // The run-level failure_reason is set to the provisioning error.
    expect(extras.db.updateTable).toHaveBeenCalledWith('execution_runs');
    expect(extras._mocks.runSetCalls).toEqual([{ failure_reason: provisioningError }]);
  });

  it('falls back to the generic message and leaves failure_reason untouched when no provisioning error', async () => {
    const expired: ExpiredJobInfo[] = [
      { id: 'q-1', runId: 'run-1', jobName: 'build', lastProvisioningError: null },
    ];
    const dedup = createMockDedup(0);
    const queue = createMockQueue(expired);
    const extras = createMockExtras();

    await runCleanup(dedup, queue, { db: extras.db, executionTracker: extras.executionTracker });

    expect(extras.executionTracker.forwardJobTerminalStatus).toHaveBeenCalledWith(
      'run-1',
      'j-1',
      'build',
      'timed_out_stale',
      'Queue timeout expired (job was never dispatched to an agent)',
    );
    // No execution_runs UPDATE is issued when there is no provisioning error.
    expect(extras.db.updateTable).not.toHaveBeenCalledWith('execution_runs');
    expect(extras._mocks.runSetCalls).toEqual([]);
  });

  it('only sets failure_reason when it is currently NULL (clobber-guard)', async () => {
    const provisioningError = 'Bare-metal scaler: spawn failed (exit 1)';
    const expired: ExpiredJobInfo[] = [
      { id: 'q-1', runId: 'run-1', jobName: 'build', lastProvisioningError: provisioningError },
    ];
    const dedup = createMockDedup(0);
    const queue = createMockQueue(expired);
    const extras = createMockExtras();

    await runCleanup(dedup, queue, { db: extras.db, executionTracker: extras.executionTracker });

    // The clobber-guard lives in the SQL WHERE clause (`failure_reason is null`):
    // the UPDATE is always issued with the provisioning error, and the
    // `failure_reason is null` predicate makes it a no-op when a real
    // step-failure reason is already recorded. Assert the guarded payload +
    // the NULL predicate are part of the update chain.
    expect(extras.db.updateTable).toHaveBeenCalledWith('execution_runs');
    expect(extras._mocks.runSetCalls).toEqual([{ failure_reason: provisioningError }]);
    // The second `.where(...)` is the NULL clobber-guard on failure_reason.
    expect(extras._mocks.runWhereCalls).toContainEqual(['failure_reason', 'is', null]);
  });
});
