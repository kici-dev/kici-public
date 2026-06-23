import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StaleRunDetector, type StaleRunDetectorDeps } from './stale-run-detector.js';

// Mock Prometheus metrics
vi.mock('../metrics/prometheus.js', () => ({
  staleRunsDetectedTotal: { add: vi.fn() },
  staleDetectionDurationSeconds: { record: vi.fn() },
  setStaleRunsCurrent: vi.fn(),
  executionsTotal: { add: vi.fn() },
  executionDurationSeconds: { record: vi.fn() },
}));

// ── Chainable mock DB ───────────────────────────────────────────

/**
 * Build a mock that mimics Kysely's chained query builder.
 * Each call to selectFrom/updateTable creates an independent chain
 * that resolves to pre-configured results.
 */
function createChainableMock(opts: {
  executeResult?: unknown[];
  executeTakeFirstResult?: unknown;
}) {
  const chain: Record<string, any> = {};
  for (const m of ['innerJoin', 'leftJoin', 'select', 'where', 'set']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.execute = vi.fn(async () => opts.executeResult ?? []);
  chain.executeTakeFirst = vi.fn(async () => opts.executeTakeFirstResult);
  return chain;
}

// ── Mock dependencies ────────────────────────────────────────────

function staleJob(overrides?: Record<string, unknown>) {
  return {
    run_id: 'run-1',
    job_id: 'job-1',
    job_name: 'test',
    agent_id: 'agent-1',
    last_heartbeat_at: new Date(Date.now() - 300_000), // 5 min ago
    rerouted_to_peer: null,
    workflow_name: 'ci',
    repo_identifier: 'owner/repo',
    sha: 'abc123',
    provider: 'github',
    provider_context: '{"installationId":42}',
    routing_key: 'github:42',
    ...overrides,
  };
}

function createDeps() {
  const executionTracker = {
    updateInMemoryJob: vi.fn(),
    forwardJobTerminalStatus: vi.fn(),
    emitInfraEvent: vi.fn(),
    completeRunIfAllJobsTerminal: vi.fn().mockResolvedValue(undefined),
    cancelStepsForJob: vi.fn().mockResolvedValue(undefined),
  };

  const checkRunReporter = {
    updateJobStatus: vi.fn(),
  };

  const scalerManager = {
    onAgentDisconnected: vi.fn(),
  };

  const dispatcher = {
    onAgentDisconnect: vi.fn().mockResolvedValue(undefined),
  };

  const registry = {
    get: vi.fn().mockReturnValue({ agentId: 'agent-1' }),
  };

  // Default registry has no peers connected, so the rerouted-job guard is a
  // no-op for local jobs (rerouted_to_peer === null) — existing behavior.
  const peerRegistry = {
    getPeer: vi.fn().mockReturnValue(undefined),
  };

  return {
    executionTracker,
    checkRunReporter,
    scalerManager,
    dispatcher,
    registry,
    peerRegistry,
  };
}

/**
 * Build a mock Kysely DB where selectFrom and updateTable calls can be
 * configured per-call-index, enabling precise control of multi-query scans.
 */
function createSequentialDb(config: {
  selects: Array<{ executeResult?: unknown[]; executeTakeFirstResult?: unknown }>;
  updates: Array<{ executeTakeFirstResult?: unknown }>;
}) {
  let selectIdx = 0;
  let updateIdx = 0;

  const db = {
    selectFrom: vi.fn(() => {
      const idx = selectIdx++;
      const cfg = config.selects[idx] ?? { executeResult: [] };
      return createChainableMock(cfg);
    }),
    updateTable: vi.fn(() => {
      const idx = updateIdx++;
      const cfg = config.updates[idx] ?? { executeTakeFirstResult: { numUpdatedRows: 0n } };
      return createChainableMock({ executeTakeFirstResult: cfg.executeTakeFirstResult });
    }),
  };

  return db as unknown as StaleRunDetectorDeps['db'];
}

function makeDeps(
  db: StaleRunDetectorDeps['db'],
  mocks: ReturnType<typeof createDeps>,
): StaleRunDetectorDeps {
  return {
    db,
    executionTracker: mocks.executionTracker as unknown as StaleRunDetectorDeps['executionTracker'],
    checkRunReporter: mocks.checkRunReporter as unknown as StaleRunDetectorDeps['checkRunReporter'],
    scalerManager: mocks.scalerManager as unknown as StaleRunDetectorDeps['scalerManager'],
    dispatcher: mocks.dispatcher as unknown as StaleRunDetectorDeps['dispatcher'],
    registry: mocks.registry as unknown as StaleRunDetectorDeps['registry'],
    peerRegistry: mocks.peerRegistry as unknown as StaleRunDetectorDeps['peerRegistry'],
    staleThresholdMs: 120_000,
    scanIntervalMs: 60_000,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('StaleRunDetector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('scan() finds and marks stale running jobs with timed_out_stale status', async () => {
    const mocks = createDeps();
    const job = staleJob();

    // Scan sequence:
    // selectFrom 0: sub-scan A (stale running jobs) -> returns [job]
    // updateTable 0: mark job timed_out_stale -> succeeds (1 row updated)
    // selectFrom 1: sub-scan B (null heartbeat) -> returns []
    // selectFrom 2: sub-scan C (dispatch queue) -> returns []
    const db = createSequentialDb({
      selects: [
        { executeResult: [job] }, // Sub-scan A
        { executeResult: [] }, // Sub-scan B
        { executeResult: [] }, // Sub-scan C
      ],
      updates: [
        { executeTakeFirstResult: { numUpdatedRows: 1n } }, // markJobStale
      ],
    });

    const detector = new StaleRunDetector(makeDeps(db, mocks));
    await detector.scan();

    // Verify updateInMemoryJob called with timed_out_stale
    expect(mocks.executionTracker.updateInMemoryJob).toHaveBeenCalledWith(
      'run-1',
      'job-1',
      'timed_out_stale',
    );

    // Verify checkRunReporter.updateJobStatus called with description and routingKey
    expect(mocks.checkRunReporter.updateJobStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'github',
        owner: 'owner',
        repo: 'repo',
        sha: 'abc123',
        workflowName: 'ci',
        jobName: 'test',
        state: 'timed_out_stale',
        description: expect.stringContaining('No heartbeat received for'),
        installationId: 42,
        routingKey: 'github:42',
      }),
    );

    // Verify force-terminate
    expect(mocks.scalerManager.onAgentDisconnected).toHaveBeenCalledWith('agent-1');

    // Verify completeRunIfAllJobsTerminal called for the affected run
    expect(mocks.executionTracker.completeRunIfAllJobsTerminal).toHaveBeenCalledWith('run-1');
  });

  it('scan() defers failing a job rerouted to a still-connected worker peer', async () => {
    const mocks = createDeps();
    // The job's worker peer is currently connected.
    mocks.peerRegistry.getPeer.mockReturnValue({ connected: true });
    const job = staleJob({ rerouted_to_peer: 'arm-stg' });

    const db = createSequentialDb({
      selects: [
        { executeResult: [job] }, // Sub-scan A returns the rerouted job
        { executeResult: [] }, // Sub-scan B
        { executeResult: [] }, // Sub-scan C
      ],
      updates: [],
    });

    const detector = new StaleRunDetector(makeDeps(db, mocks));
    await detector.scan();

    // Deferred -> no timed_out_stale transition, no Platform forward.
    expect(db.updateTable).not.toHaveBeenCalled();
    expect(mocks.executionTracker.updateInMemoryJob).not.toHaveBeenCalled();
    expect(mocks.executionTracker.forwardJobTerminalStatus).not.toHaveBeenCalled();
  });

  it('scan() still fails a job rerouted to a DISCONNECTED worker peer', async () => {
    const mocks = createDeps();
    // No peer named 'arm-stg' is connected — a dead worker must not hang the job.
    mocks.peerRegistry.getPeer.mockReturnValue(undefined);
    const job = staleJob({ rerouted_to_peer: 'arm-stg' });

    const db = createSequentialDb({
      selects: [
        { executeResult: [job] }, // Sub-scan A
        { executeResult: [] }, // Sub-scan B
        { executeResult: [] }, // Sub-scan C
      ],
      updates: [{ executeTakeFirstResult: { numUpdatedRows: 1n } }], // markJobStale
    });

    const detector = new StaleRunDetector(makeDeps(db, mocks));
    await detector.scan();

    expect(mocks.executionTracker.updateInMemoryJob).toHaveBeenCalledWith(
      'run-1',
      'job-1',
      'timed_out_stale',
    );
  });

  it('scan() defers a job whose rerouted peer is flapping (disconnected but recently seen)', async () => {
    const mocks = createDeps();
    // Peer-WS flap during a coordinator restart: the worker peer is marked
    // disconnected but its last heartbeat is recent, so it will reconnect and
    // replay the job's buffered terminal status. The run must NOT be failed.
    mocks.peerRegistry.getPeer.mockReturnValue({ connected: false, lastHeartbeatAt: Date.now() });
    const job = staleJob({ rerouted_to_peer: 'arm-stg' });

    const db = createSequentialDb({
      selects: [
        { executeResult: [job] }, // Sub-scan A returns the rerouted job
        { executeResult: [] }, // Sub-scan B
        { executeResult: [] }, // Sub-scan C
      ],
      updates: [],
    });

    const detector = new StaleRunDetector(makeDeps(db, mocks));
    await detector.scan();

    // Deferred -> no timed_out_stale transition, no Platform forward.
    expect(db.updateTable).not.toHaveBeenCalled();
    expect(mocks.executionTracker.updateInMemoryJob).not.toHaveBeenCalled();
    expect(mocks.executionTracker.forwardJobTerminalStatus).not.toHaveBeenCalled();
  });

  it('scan() still fails a job whose rerouted peer has been gone past the flap-grace window', async () => {
    const mocks = createDeps();
    // Disconnected and last heartbeat is well beyond the grace window: the
    // worker is treated as dead, so the job is timed out (it cannot hang).
    mocks.peerRegistry.getPeer.mockReturnValue({
      connected: false,
      lastHeartbeatAt: Date.now() - 10 * 60 * 1000,
    });
    const job = staleJob({ rerouted_to_peer: 'arm-stg' });

    const db = createSequentialDb({
      selects: [
        { executeResult: [job] }, // Sub-scan A
        { executeResult: [] }, // Sub-scan B
        { executeResult: [] }, // Sub-scan C
      ],
      updates: [{ executeTakeFirstResult: { numUpdatedRows: 1n } }], // markJobStale
    });

    const detector = new StaleRunDetector(makeDeps(db, mocks));
    await detector.scan();

    expect(mocks.executionTracker.updateInMemoryJob).toHaveBeenCalledWith(
      'run-1',
      'job-1',
      'timed_out_stale',
    );
  });

  it('scan() emits a held_run.expire audit row per expired hold', async () => {
    const mocks = createDeps();
    const db = createSequentialDb({
      selects: [{ executeResult: [] }, { executeResult: [] }, { executeResult: [] }],
      updates: [],
    });

    const overdueHold = {
      id: 'hold-x',
      org_id: 'org-7',
      run_id: 'run-9',
      job_id: 'deploy',
      hold_scope: 'job',
    };
    const heldRunStore = {
      listOverdue: vi.fn().mockResolvedValue([overdueHold]),
      expireOverdue: vi.fn().mockResolvedValue(1),
    } as unknown as StaleRunDetectorDeps['heldRunStore'];
    const record = vi.fn().mockResolvedValue(undefined);
    const failRun = vi.fn().mockResolvedValue(undefined);

    const detector = new StaleRunDetector({
      ...makeDeps(db, mocks),
      heldRunStore,
      failRun,
      accessLogWriter: { record } as never,
    });
    await detector.scan();

    expect(failRun).toHaveBeenCalledWith('run-9', expect.stringContaining('Approval expired'));
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-7',
        actor: { type: 'system', component: 'stale-detector' },
        action: 'held_run.expire',
        target: { type: 'held_run', id: 'hold-x' },
        outcome: 'allowed',
      }),
    );
  });

  it('scan() releases overdue wait-timer workflow holds via onWorkflowRelease', async () => {
    const mocks = createDeps();
    const db = createSequentialDb({
      selects: [{ executeResult: [] }, { executeResult: [] }, { executeResult: [] }],
      updates: [],
    });

    const waitSignal = {
      holdId: 'hold-wait',
      runId: 'run-wait',
      jobId: '__install__CI',
      scope: 'workflow',
      stepIndex: null,
      triggerSource: 'environment',
    };
    const heldRunStore = {
      releaseDueWaitHolds: vi.fn().mockResolvedValue([waitSignal]),
      listOverdue: vi.fn().mockResolvedValue([]),
      expireOverdue: vi.fn().mockResolvedValue(0),
    } as unknown as StaleRunDetectorDeps['heldRunStore'];
    const onWorkflowRelease = vi.fn().mockResolvedValue(undefined);
    const failRun = vi.fn().mockResolvedValue(undefined);

    const detector = new StaleRunDetector({
      ...makeDeps(db, mocks),
      heldRunStore,
      onWorkflowRelease,
      failRun,
    });
    await detector.scan();

    expect(onWorkflowRelease).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-wait', scope: 'workflow' }),
    );
    // A released wait hold must NOT be failed by the expire-and-fail sweep.
    expect(failRun).not.toHaveBeenCalled();
  });

  it('scan() skips jobs that were already completed (optimistic concurrency)', async () => {
    const mocks = createDeps();
    const job = staleJob();

    const db = createSequentialDb({
      selects: [
        { executeResult: [job] }, // Sub-scan A returns job
        { executeResult: [] }, // Sub-scan B
        { executeResult: [] }, // Sub-scan C
      ],
      updates: [
        { executeTakeFirstResult: { numUpdatedRows: 0n } }, // UPDATE returns 0 (already completed)
      ],
    });

    const detector = new StaleRunDetector(makeDeps(db, mocks));
    await detector.scan();

    // No side effects -- job was already completed
    expect(mocks.executionTracker.updateInMemoryJob).not.toHaveBeenCalled();
    expect(mocks.checkRunReporter.updateJobStatus).not.toHaveBeenCalled();
    expect(mocks.scalerManager.onAgentDisconnected).not.toHaveBeenCalled();
  });

  it('stale count only includes jobs actually marked (not races lost to agent)', async () => {
    const { setStaleRunsCurrent } = await import('../metrics/prometheus.js');
    const mocks = createDeps();

    // Two jobs found by SELECT, but only one UPDATE succeeds (the other completed concurrently)
    const job1 = staleJob({ run_id: 'run-1', job_id: 'job-1' });
    const job2 = staleJob({ run_id: 'run-2', job_id: 'job-2' });

    const db = createSequentialDb({
      selects: [
        { executeResult: [job1, job2] }, // Sub-scan A: 2 candidates
        { executeResult: [] }, // Sub-scan B
        { executeResult: [] }, // Sub-scan C
      ],
      updates: [
        { executeTakeFirstResult: { numUpdatedRows: 1n } }, // job1 marked
        { executeTakeFirstResult: { numUpdatedRows: 0n } }, // job2 already completed
      ],
    });

    vi.mocked(setStaleRunsCurrent).mockClear();
    const detector = new StaleRunDetector(makeDeps(db, mocks));
    await detector.scan();

    // Gauge should reflect 1 (actually marked), not 2 (found by SELECT)
    expect(setStaleRunsCurrent).toHaveBeenCalledWith(1);

    // Only run-1 should have completion check (run-2's job wasn't actually stale)
    expect(mocks.executionTracker.completeRunIfAllJobsTerminal).toHaveBeenCalledWith('run-1');
    expect(mocks.executionTracker.completeRunIfAllJobsTerminal).not.toHaveBeenCalledWith('run-2');
  });

  it('scan() handles NULL last_heartbeat_at fallback', async () => {
    const mocks = createDeps();
    const nullHeartbeatJob = staleJob({
      last_heartbeat_at: null,
      created_at: new Date(Date.now() - 300_000),
    });

    const db = createSequentialDb({
      selects: [
        { executeResult: [] }, // Sub-scan A: no stale jobs with heartbeat
        { executeResult: [nullHeartbeatJob] }, // Sub-scan B: job with null heartbeat
        { executeResult: [] }, // Sub-scan C: no dispatch queue
      ],
      updates: [
        { executeTakeFirstResult: { numUpdatedRows: 1n } }, // markJobStale
      ],
    });

    const detector = new StaleRunDetector(makeDeps(db, mocks));
    await detector.scan();

    // Verify the job was detected via sub-scan B
    expect(mocks.executionTracker.updateInMemoryJob).toHaveBeenCalledWith(
      'run-1',
      'job-1',
      'timed_out_stale',
    );

    // Verify description reflects the null-heartbeat case and routingKey is forwarded
    expect(mocks.checkRunReporter.updateJobStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'timed_out_stale',
        description: 'No heartbeat received (heartbeat was never set)',
        routingKey: 'github:42',
      }),
    );
  });

  it('scan() detects stale dispatch_queue entries AND propagates to execution_jobs', async () => {
    const mocks = createDeps();
    mocks.registry.get.mockReturnValue(null); // No agent registered

    const db = createSequentialDb({
      selects: [
        { executeResult: [] }, // Sub-scan A
        { executeResult: [] }, // Sub-scan B
        {
          executeResult: [
            {
              id: 'dq-1',
              run_id: 'run-2',
              job_name: 'build',
              status: 'dispatched',
              workflow_name: 'ci',
              repo_identifier: 'owner/repo',
              sha: 'abc123',
              provider: 'github',
              provider_context: '{"installationId":42}',
              routing_key: 'github:42',
            },
          ],
        }, // Sub-scan C
        { executeTakeFirstResult: { job_id: 'ejob-2' } }, // lookup job_id for in-memory update
      ],
      updates: [
        { executeTakeFirstResult: { numUpdatedRows: 1n } }, // dispatch_queue -> failed
        { executeTakeFirstResult: { numUpdatedRows: 1n } }, // execution_jobs -> timed_out_stale
      ],
    });

    const detector = new StaleRunDetector(makeDeps(db, mocks));
    await detector.scan();

    // Verify execution_jobs was also updated (propagation)
    expect((db as any).updateTable).toHaveBeenCalledTimes(2);

    // Verify updateInMemoryJob called with the found job_id
    expect(mocks.executionTracker.updateInMemoryJob).toHaveBeenCalledWith(
      'run-2',
      'ejob-2',
      'timed_out_stale',
    );

    // Verify completeRunIfAllJobsTerminal called for the affected run
    expect(mocks.executionTracker.completeRunIfAllJobsTerminal).toHaveBeenCalledWith('run-2');
  });

  it('scan() calls completeRunIfAllJobsTerminal for affected runs', async () => {
    const mocks = createDeps();

    // Two stale jobs from different runs
    const job1 = staleJob({ run_id: 'run-1', job_id: 'job-1' });
    const job2 = staleJob({ run_id: 'run-2', job_id: 'job-2' });

    const db = createSequentialDb({
      selects: [
        { executeResult: [job1, job2] }, // Sub-scan A: 2 stale jobs
        { executeResult: [] }, // Sub-scan B
        { executeResult: [] }, // Sub-scan C
      ],
      updates: [
        { executeTakeFirstResult: { numUpdatedRows: 1n } }, // job1 update
        { executeTakeFirstResult: { numUpdatedRows: 1n } }, // job2 update
      ],
    });

    const detector = new StaleRunDetector(makeDeps(db, mocks));
    await detector.scan();

    // Both runs should have completion checked
    expect(mocks.executionTracker.completeRunIfAllJobsTerminal).toHaveBeenCalledWith('run-1');
    expect(mocks.executionTracker.completeRunIfAllJobsTerminal).toHaveBeenCalledWith('run-2');
  });

  it('crash recovery: completeRunIfAllJobsTerminal called for affected runs', async () => {
    // Simulates: StaleRunDetector marks a job, then completeRunIfAllJobsTerminal
    // uses the DB-fallback path because in-memory state is empty (post-restart).
    // The DB-fallback itself is tested in execution-tracker.test.ts.
    const mocks = createDeps();
    const job = staleJob();

    const db = createSequentialDb({
      selects: [
        { executeResult: [job] }, // Sub-scan A
        { executeResult: [] }, // Sub-scan B
        { executeResult: [] }, // Sub-scan C
      ],
      updates: [{ executeTakeFirstResult: { numUpdatedRows: 1n } }],
    });

    const detector = new StaleRunDetector(makeDeps(db, mocks));
    await detector.scan();

    expect(mocks.executionTracker.completeRunIfAllJobsTerminal).toHaveBeenCalledWith('run-1');
  });

  it('start() runs immediate scan for crash recovery', async () => {
    const mocks = createDeps();

    const db = createSequentialDb({
      selects: [{ executeResult: [] }, { executeResult: [] }, { executeResult: [] }],
      updates: [],
    });

    const detector = new StaleRunDetector(makeDeps(db, mocks));
    await detector.start();

    // selectFrom should have been called by the immediate scan
    expect((db as any).selectFrom).toHaveBeenCalled();

    detector.stop();
  });

  it('stop() clears interval', async () => {
    const mocks = createDeps();

    const db = createSequentialDb({
      selects: [{ executeResult: [] }, { executeResult: [] }, { executeResult: [] }],
      updates: [],
    });

    const detector = new StaleRunDetector(makeDeps(db, mocks));
    await detector.start();

    // Clear call counts from initial scan
    vi.mocked((db as any).selectFrom).mockClear();

    detector.stop();

    // Advance past scan interval
    vi.advanceTimersByTime(120_000);

    // No further scans
    expect((db as any).selectFrom).not.toHaveBeenCalled();
  });

  it('force-terminates agent via scalerManager', async () => {
    const mocks = createDeps();
    const job = staleJob({ agent_id: 'agent-99' });

    const db = createSequentialDb({
      selects: [{ executeResult: [job] }, { executeResult: [] }, { executeResult: [] }],
      updates: [{ executeTakeFirstResult: { numUpdatedRows: 1n } }],
    });

    const detector = new StaleRunDetector(makeDeps(db, mocks));
    await detector.scan();

    expect(mocks.scalerManager.onAgentDisconnected).toHaveBeenCalledWith('agent-99');
    expect(mocks.dispatcher.onAgentDisconnect).toHaveBeenCalledWith('agent-99');
  });

  it('does NOT call executionTracker.onJobStatus (no redundant writes)', async () => {
    const mocks = createDeps();
    const job = staleJob();

    const db = createSequentialDb({
      selects: [{ executeResult: [job] }, { executeResult: [] }, { executeResult: [] }],
      updates: [{ executeTakeFirstResult: { numUpdatedRows: 1n } }],
    });

    const detector = new StaleRunDetector(makeDeps(db, mocks));
    await detector.scan();

    // The executionTracker mock does not have onJobStatus.
    // This confirms the detector never tries to call it -- only updateInMemoryJob.
    expect(mocks.executionTracker).not.toHaveProperty('onJobStatus');
    expect(mocks.executionTracker.updateInMemoryJob).toHaveBeenCalled();
  });

  it('cleanupOrphanedRecoveryJobs() checks run completion for affected runs', async () => {
    const mocks = createDeps();

    // Sequence: selectFrom (find recovering jobs), updateTable (fail execution_jobs),
    // updateTable (fail dispatch_queue)
    const db = createSequentialDb({
      selects: [
        {
          executeResult: [{ run_id: 'run-A' }, { run_id: 'run-A' }, { run_id: 'run-B' }],
        },
      ],
      updates: [
        { executeTakeFirstResult: { numUpdatedRows: 2n } }, // execution_jobs
        { executeTakeFirstResult: { numUpdatedRows: 2n } }, // dispatch_queue
      ],
    });

    const detector = new StaleRunDetector(makeDeps(db, mocks));
    await detector.cleanupOrphanedRecoveryJobs();

    // Both distinct run IDs should have completion checked
    expect(mocks.executionTracker.completeRunIfAllJobsTerminal).toHaveBeenCalledWith('run-A');
    expect(mocks.executionTracker.completeRunIfAllJobsTerminal).toHaveBeenCalledWith('run-B');
    expect(mocks.executionTracker.completeRunIfAllJobsTerminal).toHaveBeenCalledTimes(2);
  });

  it('cleanupOrphanedRecoveryJobs() is a no-op when no recovering jobs exist', async () => {
    const mocks = createDeps();

    const db = createSequentialDb({
      selects: [{ executeResult: [] }],
      updates: [],
    });

    const detector = new StaleRunDetector(makeDeps(db, mocks));
    await detector.cleanupOrphanedRecoveryJobs();

    // No updates should have been performed
    expect((db as any).updateTable).not.toHaveBeenCalled();
    expect(mocks.executionTracker.completeRunIfAllJobsTerminal).not.toHaveBeenCalled();
  });

  it('handles DB errors gracefully', async () => {
    const mocks = createDeps();

    const db = {
      selectFrom: vi.fn(() => {
        throw new Error('DB connection lost');
      }),
      updateTable: vi.fn(() => createChainableMock({})),
    } as unknown as StaleRunDetectorDeps['db'];

    const detector = new StaleRunDetector(makeDeps(db, mocks));

    // Should not throw -- scan() catches errors internally
    await expect(detector.scan()).resolves.toBeUndefined();
  });

  it('does not force-terminate when job has no agent_id', async () => {
    const mocks = createDeps();
    const job = staleJob({ agent_id: null });

    const db = createSequentialDb({
      selects: [{ executeResult: [job] }, { executeResult: [] }, { executeResult: [] }],
      updates: [{ executeTakeFirstResult: { numUpdatedRows: 1n } }],
    });

    const detector = new StaleRunDetector(makeDeps(db, mocks));
    await detector.scan();

    expect(mocks.scalerManager.onAgentDisconnected).not.toHaveBeenCalled();
    expect(mocks.dispatcher.onAgentDisconnect).not.toHaveBeenCalled();
  });
});
