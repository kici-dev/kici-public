import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCleanup } from './cleanup.js';
import type { JobQueue, ExpiredJobInfo } from './job-queue.js';
import type { ExecutionTracker } from '../reporting/execution-tracker.js';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';

/**
 * An `ExpiredJobInfo` as `markExpired()` returns it. Defaults to a job whose
 * `runsOn` is satisfiable, so a test only states the routing selectors when the
 * routable/unroutable split is what it is exercising.
 */
function expiredJob(
  over: Partial<ExpiredJobInfo> & Pick<ExpiredJobInfo, 'id' | 'runId' | 'jobName'>,
): ExpiredJobInfo {
  return {
    lastProvisioningError: null,
    runsOnLabels: ['default'],
    runsOnPatterns: [],
    excludeLabels: [],
    excludePatterns: [],
    ...over,
  };
}

function createMockDedup(deleted = 0) {
  return { cleanup: vi.fn().mockResolvedValue(deleted) };
}

function createMockQueue(expiredJobs: ExpiredJobInfo[] = [], prunedRows = 0) {
  return {
    markExpired: vi.fn().mockResolvedValue(expiredJobs),
    pruneTerminalDispatchRows: vi.fn().mockResolvedValue(prunedRows),
  } as unknown as JobQueue;
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

  const getExecutionContext = vi.fn().mockReturnValue({
    workflowName: 'ci',
    provider: 'github',
    repoIdentifier: 'acme/widgets',
    sha: 'deadbeef',
    installationId: 4242,
    routingKey: 'github:4242',
  });

  const executionTracker = {
    updateInMemoryJob: vi.fn(),
    forwardJobTerminalStatus: vi.fn(),
    emitInfraEvent: vi.fn(),
    completeRunIfAllJobsTerminal: vi.fn().mockResolvedValue(undefined),
    getExecutionContext,
  } as unknown as ExecutionTracker;

  const checkRunReporter = { updateJobStatus: vi.fn() };

  return {
    db,
    executionTracker,
    checkRunReporter,
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
      dispatchRowsPruned: 0,
      logObjectsPruned: 0,
      checkRunRowsPruned: 0,
    });
  });

  it('returns expired count from markExpired array length', async () => {
    const expired: ExpiredJobInfo[] = [
      expiredJob({ id: 'q-1', runId: 'run-1', jobName: 'build' }),
      expiredJob({ id: 'q-2', runId: 'run-2', jobName: 'test' }),
    ];
    const dedup = createMockDedup(0);
    const queue = createMockQueue(expired);

    const result = await runCleanup(dedup, queue);

    expect(result).toEqual({
      dedupDeleted: 0,
      queueExpired: 2,
      dispatchRowsPruned: 0,
      logObjectsPruned: 0,
      checkRunRowsPruned: 0,
    });
  });

  it('skips Platform forwarding when extras is not provided', async () => {
    const expired: ExpiredJobInfo[] = [expiredJob({ id: 'q-1', runId: 'run-1', jobName: 'build' })];
    const dedup = createMockDedup(0);
    const queue = createMockQueue(expired);

    // No extras -- independent mode
    const result = await runCleanup(dedup, queue);

    expect(result.queueExpired).toBe(1);
    // No errors, no forwarding attempts
  });

  it('forwards expired jobs to Platform when extras is provided', async () => {
    const expired: ExpiredJobInfo[] = [expiredJob({ id: 'q-1', runId: 'run-1', jobName: 'build' })];
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
      expiredJob({ id: 'q-1', runId: 'run-1', jobName: 'build' }),
      expiredJob({ id: 'q-2', runId: 'run-1', jobName: 'test' }),
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
    const expired: ExpiredJobInfo[] = [expiredJob({ id: 'q-1', runId: 'run-1', jobName: 'build' })];
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
      expiredJob({ id: 'q-1', runId: 'run-1', jobName: 'build' }),
      expiredJob({ id: 'q-2', runId: 'run-2', jobName: 'test' }),
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
      expiredJob({
        id: 'q-1',
        runId: 'run-1',
        jobName: 'build',
        lastProvisioningError: provisioningError,
      }),
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
    const expired: ExpiredJobInfo[] = [expiredJob({ id: 'q-1', runId: 'run-1', jobName: 'build' })];
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
      expiredJob({
        id: 'q-1',
        runId: 'run-1',
        jobName: 'build',
        lastProvisioningError: provisioningError,
      }),
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

  it('terminalizes a job no agent can run as unroutable, naming the unsatisfied runsOn', async () => {
    // The false-green this status exists to end: the job never dispatched, so
    // without a terminal verdict the run finished green on its siblings alone.
    const expired: ExpiredJobInfo[] = [
      expiredJob({
        id: 'q-1',
        runId: 'run-1',
        jobName: 'build',
        runsOnLabels: ['gpu', 'linux'],
        excludeLabels: ['retired'],
      }),
    ];
    const dedup = createMockDedup(0);
    const queue = createMockQueue(expired);
    const extras = createMockExtras();

    await runCleanup(dedup, queue, {
      db: extras.db,
      executionTracker: extras.executionTracker,
      canRouteLabels: () => false,
    });

    expect(extras.executionTracker.updateInMemoryJob).toHaveBeenCalledWith(
      'run-1',
      'j-1',
      'unroutable',
    );
    expect(extras.executionTracker.forwardJobTerminalStatus).toHaveBeenCalledWith(
      'run-1',
      'j-1',
      'build',
      'unroutable',
      'No connected agent or scaler backend currently matches runsOn [gpu, linux] ' +
        'excluding [retired] — the job was never dispatched',
    );
  });

  it('resolves the expired job check run, naming the unmatched selectors', async () => {
    // This sweep settles the job by writing execution_jobs directly, so the
    // execution tracker's terminal-job hook never fires for it. Without an
    // explicit post here the check run created at trigger match stays `queued`
    // on the commit forever and no branch-protection rule requiring it can ever
    // be satisfied.
    const expired: ExpiredJobInfo[] = [
      expiredJob({ id: 'q-1', runId: 'run-1', jobName: 'build', runsOnLabels: ['gpu'] }),
    ];
    const dedup = createMockDedup(0);
    const queue = createMockQueue(expired);
    const extras = createMockExtras();

    await runCleanup(dedup, queue, {
      db: extras.db,
      executionTracker: extras.executionTracker,
      checkRunReporter: extras.checkRunReporter,
      canRouteLabels: () => false,
    });

    expect(extras.checkRunReporter.updateJobStatus).toHaveBeenCalledTimes(1);
    expect(extras.checkRunReporter.updateJobStatus.mock.calls[0][0]).toMatchObject({
      provider: 'github',
      owner: 'acme',
      repo: 'widgets',
      sha: 'deadbeef',
      workflowName: 'ci',
      jobName: 'build',
      state: 'unroutable',
      installationId: 4242,
      routingKey: 'github:4242',
      runId: 'run-1',
      jobId: 'j-1',
      description:
        'No connected agent or scaler backend currently matches runsOn [gpu] — ' +
        'the job was never dispatched',
    });
  });

  it('resolves the check run for a routable job that expired as timed_out_stale', async () => {
    const expired: ExpiredJobInfo[] = [expiredJob({ id: 'q-1', runId: 'run-1', jobName: 'build' })];
    const dedup = createMockDedup(0);
    const queue = createMockQueue(expired);
    const extras = createMockExtras();

    await runCleanup(dedup, queue, {
      db: extras.db,
      executionTracker: extras.executionTracker,
      checkRunReporter: extras.checkRunReporter,
      canRouteLabels: () => true,
    });

    expect(extras.checkRunReporter.updateJobStatus).toHaveBeenCalledTimes(1);
    expect(extras.checkRunReporter.updateJobStatus.mock.calls[0][0]).toMatchObject({
      state: 'timed_out_stale',
      jobName: 'build',
    });
  });

  it('does not post a check-run update when the execution_jobs update affects 0 rows', async () => {
    const expired: ExpiredJobInfo[] = [expiredJob({ id: 'q-1', runId: 'run-1', jobName: 'build' })];
    const dedup = createMockDedup(0);
    const queue = createMockQueue(expired);
    const extras = createMockExtras();
    extras._mocks.updateExecuteTakeFirst.mockResolvedValue({ numUpdatedRows: 0n });

    await runCleanup(dedup, queue, {
      db: extras.db,
      executionTracker: extras.executionTracker,
      checkRunReporter: extras.checkRunReporter,
    });

    expect(extras.checkRunReporter.updateJobStatus).not.toHaveBeenCalled();
  });

  it('promotes the unroutable reason to the run, under the same NULL clobber-guard', async () => {
    // The unmatched-selector text is the only statement of WHICH labels went
    // unmet. Left off the run, every surface renders the generic
    // `Failed jobs: <name>` roll-up and the operator's lead disappears.
    const expired: ExpiredJobInfo[] = [
      expiredJob({ id: 'q-1', runId: 'run-1', jobName: 'build', runsOnLabels: ['gpu'] }),
    ];
    const dedup = createMockDedup(0);
    const queue = createMockQueue(expired);
    const extras = createMockExtras();

    await runCleanup(dedup, queue, {
      db: extras.db,
      executionTracker: extras.executionTracker,
      canRouteLabels: () => false,
    });

    expect(extras._mocks.runSetCalls).toHaveLength(1);
    expect(String(extras._mocks.runSetCalls[0].failure_reason)).toContain('runsOn [gpu]');
    // Never clobber a real step-failure reason already recorded on the run.
    expect(extras._mocks.runWhereCalls).toContainEqual(['failure_reason', 'is', null]);
  });

  it('names the job rather than an empty selector list when runsOn is empty', async () => {
    // `runsOn []` reads as a broken message; the honest statement is that the
    // job would take any agent and none is connected.
    const expired: ExpiredJobInfo[] = [
      expiredJob({ id: 'q-1', runId: 'run-1', jobName: 'build', runsOnLabels: [] }),
    ];
    const dedup = createMockDedup(0);
    const queue = createMockQueue(expired);
    const extras = createMockExtras();

    await runCleanup(dedup, queue, {
      db: extras.db,
      executionTracker: extras.executionTracker,
      canRouteLabels: () => false,
    });

    const message = String(extras._mocks.runSetCalls[0].failure_reason);
    expect(message).not.toContain('runsOn []');
    expect(message).toContain('declares no runsOn');
  });

  it('renders regex selectors readably in the unroutable message', async () => {
    const expired: ExpiredJobInfo[] = [
      expiredJob({
        id: 'q-1',
        runId: 'run-1',
        jobName: 'build',
        runsOnLabels: [],
        runsOnPatterns: [{ kind: 'regex', source: '^gpu-.*$', flags: 'i' }],
      }),
    ];
    const dedup = createMockDedup(0);
    const queue = createMockQueue(expired);
    const extras = createMockExtras();

    await runCleanup(dedup, queue, {
      db: extras.db,
      executionTracker: extras.executionTracker,
      canRouteLabels: () => false,
    });

    expect(extras.executionTracker.forwardJobTerminalStatus).toHaveBeenCalledWith(
      'run-1',
      'j-1',
      'build',
      'unroutable',
      'No connected agent or scaler backend currently matches runsOn [/^gpu-.*$/i] — ' +
        'the job was never dispatched',
    );
  });

  it('keeps timed_out_stale when a matching agent existed but never freed up', async () => {
    // A capacity problem, not a fleet/label problem: the two must not collapse
    // onto one status, or "fix your runsOn" is the advice for a busy fleet.
    const expired: ExpiredJobInfo[] = [
      expiredJob({ id: 'q-1', runId: 'run-1', jobName: 'build', runsOnLabels: ['linux'] }),
    ];
    const dedup = createMockDedup(0);
    const queue = createMockQueue(expired);
    const extras = createMockExtras();
    const canRouteLabels = vi.fn().mockReturnValue(true);

    await runCleanup(dedup, queue, {
      db: extras.db,
      executionTracker: extras.executionTracker,
      canRouteLabels,
    });

    expect(canRouteLabels).toHaveBeenCalledWith(['linux'], [], [], []);
    expect(extras.executionTracker.forwardJobTerminalStatus).toHaveBeenCalledWith(
      'run-1',
      'j-1',
      'build',
      'timed_out_stale',
      'Queue timeout expired (job was never dispatched to an agent)',
    );
  });

  it('a recorded provisioning error keeps timed_out_stale, never unroutable', async () => {
    // A failed spawn PROVES the labels routed — the scaler matched a backend and
    // got as far as attempting an agent. Reporting that as `unroutable` would
    // send an operator to fix a `runsOn` that is already correct, and it would
    // silently reclassify the whole scaler-provisioning-failure surface. The
    // probe is not even consulted.
    const provisioningError = 'Container scaler: image pull failed (manifest unknown)';
    const expired: ExpiredJobInfo[] = [
      expiredJob({
        id: 'q-1',
        runId: 'run-1',
        jobName: 'build',
        lastProvisioningError: provisioningError,
      }),
    ];
    const dedup = createMockDedup(0);
    const queue = createMockQueue(expired);
    const extras = createMockExtras();
    const canRouteLabels = vi.fn().mockReturnValue(false);

    await runCleanup(dedup, queue, {
      db: extras.db,
      executionTracker: extras.executionTracker,
      canRouteLabels,
    });

    expect(canRouteLabels).not.toHaveBeenCalled();
    expect(extras.executionTracker.forwardJobTerminalStatus).toHaveBeenCalledWith(
      'run-1',
      'j-1',
      'build',
      'timed_out_stale',
      provisioningError,
    );
  });

  it('prunes terminal dispatch rows using the configured retention', async () => {
    const dedup = createMockDedup(0);
    const queue = createMockQueue([], 3);
    const extras = createMockExtras();

    const res = await runCleanup(dedup, queue, {
      db: extras.db,
      executionTracker: extras.executionTracker,
      dispatchQueueTtlDays: 7,
    });

    expect(queue.pruneTerminalDispatchRows).toHaveBeenCalledWith(7);
    expect(res.dispatchRowsPruned).toBe(3);
  });

  it('defaults dispatch retention to 30 days when unset', async () => {
    const dedup = createMockDedup(0);
    const queue = createMockQueue([], 1);
    const extras = createMockExtras();

    await runCleanup(dedup, queue, {
      db: extras.db,
      executionTracker: extras.executionTracker,
    });

    expect(queue.pruneTerminalDispatchRows).toHaveBeenCalledWith(30);
  });

  it('does NOT prune dispatch rows in independent mode (no extras)', async () => {
    const dedup = createMockDedup(0);
    const queue = createMockQueue([], 5);

    const res = await runCleanup(dedup, queue);

    expect(queue.pruneTerminalDispatchRows).not.toHaveBeenCalled();
    expect(res.dispatchRowsPruned).toBe(0);
  });

  it('prunes expired step logs when an S3 log storage is provided', async () => {
    const dedup = createMockDedup(0);
    const queue = createMockQueue([]);
    const extras = createMockExtras();
    const logStorage = {
      listWithMetadata: vi
        .fn()
        .mockResolvedValue([
          { path: 'executions/r/j/step-0.log', lastModified: new Date('2000-01-01T00:00:00Z') },
        ]),
      deleteMany: vi.fn().mockResolvedValue(1),
    } as unknown as import('../reporting/log-storage.js').LogStorage;

    const res = await runCleanup(dedup, queue, {
      db: extras.db,
      executionTracker: extras.executionTracker,
      stepLogTtlDays: 30,
      logStorage,
      logStorageIsS3: true,
    });

    expect(res.logObjectsPruned).toBe(1);
    expect(logStorage.deleteMany).toHaveBeenCalledWith(['executions/r/j/step-0.log']);
  });

  it('skips the log sweep for a filesystem backend', async () => {
    const dedup = createMockDedup(0);
    const queue = createMockQueue([]);
    const extras = createMockExtras();
    const logStorage = {
      listWithMetadata: vi.fn(),
      deleteMany: vi.fn(),
    } as unknown as import('../reporting/log-storage.js').LogStorage;

    const res = await runCleanup(dedup, queue, {
      db: extras.db,
      executionTracker: extras.executionTracker,
      stepLogTtlDays: 30,
      logStorage,
      logStorageIsS3: false,
    });

    expect(res.logObjectsPruned).toBe(0);
    expect(logStorage.listWithMetadata).not.toHaveBeenCalled();
  });

  it('prunes stale check-run tracking rows using the cluster-settings value', async () => {
    const dedup = createMockDedup(0);
    const queue = createMockQueue([]);
    const extras = createMockExtras();
    const trackingStore = { pruneStale: vi.fn().mockResolvedValue(6) };
    const clusterSettings = { getNumber: vi.fn().mockResolvedValue(14) };

    const result = await runCleanup(dedup, queue, {
      ...extras,
      checkRunTrackingStore: trackingStore as never,
      clusterSettings: clusterSettings as never,
      checkRunTrackingTtlDays: 7,
    });

    expect(clusterSettings.getNumber).toHaveBeenCalledWith('check_run_tracking_ttl_days', 7);
    expect(trackingStore.pruneStale).toHaveBeenCalledWith(14);
    expect(result.checkRunRowsPruned).toBe(6);
  });

  it('falls back to the config default when no cluster-settings reader is wired', async () => {
    const dedup = createMockDedup(0);
    const queue = createMockQueue([]);
    const extras = createMockExtras();
    const trackingStore = { pruneStale: vi.fn().mockResolvedValue(0) };

    await runCleanup(dedup, queue, {
      ...extras,
      checkRunTrackingStore: trackingStore as never,
      checkRunTrackingTtlDays: 7,
    });

    expect(trackingStore.pruneStale).toHaveBeenCalledWith(7);
  });

  it('passes a cluster-settings 0 straight through, disabling the sweep', async () => {
    // 0 is the documented disable value, and it is falsy — a `||` fallback
    // anywhere on this path would silently substitute the 7-day default and
    // make the knob impossible to turn off.
    const dedup = createMockDedup(0);
    const queue = createMockQueue([]);
    const extras = createMockExtras();
    const trackingStore = { pruneStale: vi.fn().mockResolvedValue(0) };
    const clusterSettings = { getNumber: vi.fn().mockResolvedValue(0) };

    await runCleanup(dedup, queue, {
      ...extras,
      checkRunTrackingStore: trackingStore as never,
      clusterSettings: clusterSettings as never,
      checkRunTrackingTtlDays: 7,
    });

    expect(trackingStore.pruneStale).toHaveBeenCalledWith(0);
  });

  it('logs and continues when the check-run tracking sweep throws', async () => {
    const dedup = createMockDedup(3);
    const queue = createMockQueue([]);
    const extras = createMockExtras();
    const trackingStore = {
      pruneStale: vi.fn().mockRejectedValue(new Error('boom')),
    };

    const result = await runCleanup(dedup, queue, {
      ...extras,
      checkRunTrackingStore: trackingStore as never,
    });

    expect(result.dedupDeleted).toBe(3);
    expect(result.checkRunRowsPruned).toBe(0);
  });

  it('skips the sweep entirely when no tracking store is wired', async () => {
    const dedup = createMockDedup(0);
    const queue = createMockQueue([]);
    const extras = createMockExtras();

    const result = await runCleanup(dedup, queue, { ...extras });

    expect(result.checkRunRowsPruned).toBe(0);
  });
});
