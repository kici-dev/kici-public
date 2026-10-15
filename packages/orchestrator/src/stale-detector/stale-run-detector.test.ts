import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StaleRunDetector, type StaleRunDetectorDeps } from './stale-run-detector.js';
import {
  CheckRunConclusion,
  HoldScope,
  HoldType,
  INSTALL_JOB_ID_PREFIX,
  installGateJobId,
  SECURITY_HOLD_JOB_IDS,
} from '@kici-dev/engine';
import {
  clearPendingWorkflowContextsMap,
  loadPendingWorkflowContext,
  storePendingWorkflowContext,
} from '../pipeline/pending-workflow-context.js';

vi.mock('../metrics/prometheus.js', () => ({
  staleRunsDetectedTotal: { add: vi.fn() },
  staleDetectionDurationSeconds: { record: vi.fn() },
  setStaleRunsCurrent: vi.fn(),
  executionsTotal: { add: vi.fn() },
  executionDurationSeconds: { record: vi.fn() },
}));

// ── Chainable mock DB ───────────────────────────────────────────

/** One independent Kysely-like query chain resolving to pre-configured results. */
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
    pruneRunsFinishedElsewhere: vi.fn().mockResolvedValue(0),
    cancelStepsForJob: vi.fn().mockResolvedValue(undefined),
  };

  const checkRunReporter = {
    updateJobStatus: vi.fn(),
    completeUndispatchedCheckRuns: vi.fn().mockResolvedValue(undefined),
  };

  const scalerManager = {
    onAgentDisconnected: vi.fn(),
  };

  // Tracks no job to any agent; a test expecting a disconnect maps the stale job to it.
  const dispatcher = {
    onAgentDisconnect: vi.fn().mockResolvedValue(undefined),
    getAgentIdForJob: vi.fn((_jobId: string): string | null => null),
  };

  const registry = {
    get: vi.fn().mockReturnValue({ agentId: 'agent-1' }),
  };

  // No peers connected, so the rerouted-job guard is a no-op for local jobs
  // (rerouted_to_peer === null).
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

/** A mock Kysely DB whose selectFrom and updateTable results are configured per call index. */
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
    // The expiry sweep calls `deletePendingWorkflowContext`; without this it throws into the
    // sweep's catch, silently skipping the rest of the sweep.
    deleteFrom: vi.fn(() => createChainableMock({})),
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
    clusterSettings: {
      getNumber: async (_col: string, fallback: number) => fallback,
    } as unknown as StaleRunDetectorDeps['clusterSettings'],
    rerouteFlapGraceFallbackMs: 120_000,
    staleThresholdMs: 120_000,
    scanIntervalMs: 60_000,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('StaleRunDetector — wait-timer release routing', () => {
  /** A minimal detector whose only live dependency is the held-run store. */
  function detectorWith(
    released: Array<Record<string, unknown>>,
    handlers: {
      onWorkflowRelease?: ReturnType<typeof vi.fn>;
      onJobRelease?: ReturnType<typeof vi.fn>;
    },
  ) {
    const mocks = createDeps();
    const deps = makeDeps(createSequentialDb({ selects: [], updates: [] }), mocks);
    return new StaleRunDetector({
      ...deps,
      heldRunStore: {
        releaseDueWaitHolds: vi.fn().mockResolvedValue(released),
        expireOverdue: vi.fn().mockResolvedValue(0),
        listOverdue: vi.fn().mockResolvedValue([]),
      } as unknown as StaleRunDetectorDeps['heldRunStore'],
      ...handlers,
    } as StaleRunDetectorDeps);
  }

  /** Drive the private sweep directly — it is the unit under test. */
  const sweep = (d: StaleRunDetector) =>
    (d as unknown as { releaseDueWaitHolds(): Promise<void> }).releaseDueWaitHolds();

  it('routes a JOB-scoped wait release to the job path, not the workflow path', async () => {
    // onWorkflowRelease would re-dispatch the whole workflow instead of the held job.
    const onJobRelease = vi.fn().mockResolvedValue(undefined);
    const onWorkflowRelease = vi.fn().mockResolvedValue(undefined);
    const d = detectorWith(
      [
        {
          holdId: 'h1',
          runId: 'r1',
          jobId: 'build',
          stepIndex: null,
          scope: 'job',
          triggerSource: 'context',
        },
      ],
      { onJobRelease, onWorkflowRelease },
    );

    await sweep(d);

    expect(onJobRelease).toHaveBeenCalledTimes(1);
    expect(onJobRelease.mock.calls[0][0]).toMatchObject({ runId: 'r1', jobId: 'build' });
    expect(onWorkflowRelease).not.toHaveBeenCalled();
  });

  it('still routes a WORKFLOW-scoped wait release to the install-gate path', async () => {
    // Positive control for the job-scoped routing above.
    const onJobRelease = vi.fn().mockResolvedValue(undefined);
    const onWorkflowRelease = vi.fn().mockResolvedValue(undefined);
    const d = detectorWith(
      [
        {
          holdId: 'h2',
          runId: 'r2',
          jobId: INSTALL_JOB_ID_PREFIX,
          stepIndex: null,
          scope: 'workflow',
          triggerSource: 'context',
        },
      ],
      { onJobRelease, onWorkflowRelease },
    );

    await sweep(d);

    expect(onWorkflowRelease).toHaveBeenCalledTimes(1);
    expect(onJobRelease).not.toHaveBeenCalled();
  });

  it('sweeps even when only a job-release handler is wired', async () => {
    // The guard must not require onWorkflowRelease.
    const onJobRelease = vi.fn().mockResolvedValue(undefined);
    const d = detectorWith(
      [
        {
          holdId: 'h3',
          runId: 'r3',
          jobId: 'deploy',
          stepIndex: null,
          scope: 'job',
          triggerSource: 'context',
        },
      ],
      { onJobRelease },
    );

    await sweep(d);

    expect(onJobRelease).toHaveBeenCalledTimes(1);
  });
});

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

    // Sub-scan A: stale running jobs; B: null heartbeat; C: dispatch queue.
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

    expect(mocks.executionTracker.updateInMemoryJob).toHaveBeenCalledWith(
      'run-1',
      'job-1',
      'timed_out_stale',
    );

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

    // Force-terminate.
    expect(mocks.scalerManager.onAgentDisconnected).toHaveBeenCalledWith('agent-1');

    expect(mocks.executionTracker.completeRunIfAllJobsTerminal).toHaveBeenCalledWith('run-1');
  });

  it('scan() defers failing a job rerouted to a still-connected worker peer', async () => {
    const mocks = createDeps();
    mocks.peerRegistry.getPeer.mockReturnValue({ connected: true });
    const job = staleJob({ rerouted_to_peer: 'arm-worker' });

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
    // No peer named 'arm-worker' is connected — a dead worker must not hang the job.
    mocks.peerRegistry.getPeer.mockReturnValue(undefined);
    const job = staleJob({ rerouted_to_peer: 'arm-worker' });

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
    // Peer-WS flap during a coordinator restart: disconnected but recently seen, so the
    // worker will reconnect and replay the buffered terminal status. Must NOT fail the run.
    mocks.peerRegistry.getPeer.mockReturnValue({ connected: false, lastHeartbeatAt: Date.now() });
    const job = staleJob({ rerouted_to_peer: 'arm-worker' });

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
    // Last heartbeat well past the grace window: the worker is dead, so the job times out.
    mocks.peerRegistry.getPeer.mockReturnValue({
      connected: false,
      lastHeartbeatAt: Date.now() - 10 * 60 * 1000,
    });
    const job = staleJob({ rerouted_to_peer: 'arm-worker' });

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

  it('scan() fails an expired WORKFLOW-scoped hold instead of resuming it', async () => {
    // The org trust policy's PR-wide hold stores a dispatch context that a release replays.
    // Expiry must never take that path: an elapsed approval window is a denial.
    const mocks = createDeps();
    const db = createSequentialDb({
      selects: [{ executeResult: [] }, { executeResult: [] }, { executeResult: [] }],
      updates: [],
    });

    // Without a stored context, the "dropped" assertion below would pass vacuously.
    clearPendingWorkflowContextsMap();
    await storePendingWorkflowContext(undefined, {
      runId: 'run-fork',
      resolvedOrgId: 'org-7',
    } as never);
    expect(await loadPendingWorkflowContext(undefined, 'run-fork')).not.toBeNull();

    const heldRunStore = {
      // The wait-timer sweep's `hold_type` filter excludes `security`, so a security hold
      // only reaches the expire path.
      releaseDueWaitHolds: vi.fn().mockResolvedValue([]),
      listOverdue: vi.fn().mockResolvedValue([
        {
          id: 'hold-fork',
          org_id: 'org-7',
          run_id: 'run-fork',
          job_id: SECURITY_HOLD_JOB_IDS.fork_pr,
          hold_scope: 'workflow',
        },
      ]),
      expireOverdue: vi.fn().mockResolvedValue(1),
    } as unknown as StaleRunDetectorDeps['heldRunStore'];
    const failRun = vi.fn().mockResolvedValue(undefined);
    const onWorkflowRelease = vi.fn().mockResolvedValue(undefined);
    const onJobRelease = vi.fn().mockResolvedValue(undefined);

    const detector = new StaleRunDetector({
      ...makeDeps(db, mocks),
      heldRunStore,
      failRun,
      onWorkflowRelease,
      onJobRelease,
    } as StaleRunDetectorDeps);
    await detector.scan();

    expect(failRun).toHaveBeenCalledWith('run-fork', expect.stringContaining('Approval expired'));
    expect(onWorkflowRelease).not.toHaveBeenCalled();
    expect(onJobRelease).not.toHaveBeenCalled();
    // Expiry drops the stored context too: an unanswered hold (the common fork-PR outcome)
    // gets no release or rejection, so the row would accumulate until a restart.
    expect(await loadPendingWorkflowContext(undefined, 'run-fork')).toBeNull();
  });

  it('scan() leaves a JOB-scoped expired hold no workflow context to drop', async () => {
    // Control: the cleanup is keyed on scope. A job-scoped hold wrote no workflow context,
    // and deleting by run id could take out a still-live hold's context on the same run.
    const mocks = createDeps();
    const db = createSequentialDb({
      selects: [{ executeResult: [] }, { executeResult: [] }, { executeResult: [] }],
      updates: [],
    });
    clearPendingWorkflowContextsMap();
    await storePendingWorkflowContext(undefined, {
      runId: 'run-job',
      resolvedOrgId: 'org-7',
    } as never);

    const heldRunStore = {
      releaseDueWaitHolds: vi.fn().mockResolvedValue([]),
      listOverdue: vi.fn().mockResolvedValue([
        {
          id: 'hold-job',
          org_id: 'org-7',
          run_id: 'run-job',
          job_id: 'build',
          hold_scope: 'job',
        },
      ]),
      expireOverdue: vi.fn().mockResolvedValue(1),
    } as unknown as StaleRunDetectorDeps['heldRunStore'];

    const detector = new StaleRunDetector({
      ...makeDeps(db, mocks),
      heldRunStore,
      failRun: vi.fn().mockResolvedValue(undefined),
    } as StaleRunDetectorDeps);
    await detector.scan();

    expect(await loadPendingWorkflowContext(undefined, 'run-job')).not.toBeNull();
    expect(mocks.checkRunReporter.completeUndispatchedCheckRuns).not.toHaveBeenCalled();
    clearPendingWorkflowContextsMap();
  });

  it('scan() completes the queued check runs of an expired WORKFLOW-scoped hold', async () => {
    // `failRun` writes DB rows only, a held run has no in-memory run to fire
    // `onExecutionComplete`, and the stale check-run sweep only touches `in_progress`: without
    // this the `kici/<workflow>` and per-job checks stay `queued` on the commit forever.
    const mocks = createDeps();
    const db = createSequentialDb({
      selects: [{ executeResult: [] }, { executeResult: [] }, { executeResult: [] }],
      updates: [],
    });

    clearPendingWorkflowContextsMap();
    await storePendingWorkflowContext(undefined, {
      runId: 'run-fork',
      resolvedOrgId: 'org-7',
      repoIdentifier: 'acme/app',
      ref: 'cafebabe',
      credentials: { installationId: 42 },
      info: { provider: 'github', routingKey: 'github:1' },
      workflow: {
        name: 'CI',
        jobs: [
          { _type: 'static', name: 'build' },
          { _type: 'dynamic', name: 'gen' },
        ],
      },
    } as never);

    const heldRunStore = {
      releaseDueWaitHolds: vi.fn().mockResolvedValue([]),
      listOverdue: vi.fn().mockResolvedValue([
        {
          id: 'hold-fork',
          org_id: 'org-7',
          run_id: 'run-fork',
          job_id: SECURITY_HOLD_JOB_IDS.fork_pr,
          hold_scope: 'workflow',
        },
      ]),
      expireOverdue: vi.fn().mockResolvedValue(1),
    } as unknown as StaleRunDetectorDeps['heldRunStore'];

    const detector = new StaleRunDetector({
      ...makeDeps(db, mocks),
      heldRunStore,
      failRun: vi.fn().mockResolvedValue(undefined),
    } as StaleRunDetectorDeps);
    await detector.scan();

    expect(mocks.checkRunReporter.completeUndispatchedCheckRuns).toHaveBeenCalledTimes(1);
    expect(mocks.checkRunReporter.completeUndispatchedCheckRuns.mock.calls[0][0]).toMatchObject({
      provider: 'github',
      routingKey: 'github:1',
      owner: 'acme',
      repo: 'app',
      sha: 'cafebabe',
      workflowName: 'CI',
      jobNames: ['build'],
      installationId: 42,
      runId: 'run-fork',
      conclusion: CheckRunConclusion.enum.timed_out,
    });
    clearPendingWorkflowContextsMap();
  });

  describe('scan() finishes a run whose every job is terminal', () => {
    it('routes each all-terminal candidate through the run completion check', async () => {
      const mocks = createDeps();
      // A, B, C find nothing; sweep F reads one candidate run, then its holder's heartbeat.
      const db = createSequentialDb({
        selects: [
          { executeResult: [] },
          { executeResult: [] },
          { executeResult: [] },
          {
            executeResult: [
              { run_id: 'run-orphaned', registration_window_instance_id: 'coord-dead' },
            ],
          },
          { executeResult: [] },
        ],
        updates: [],
      });
      const detector = new StaleRunDetector(makeDeps(db, mocks));
      await detector.scan();

      // breaks-if-wrong: a run whose window holder died after a sibling
      // deferred to it — every job terminal, the run row still running — has
      // no other finalizer left; this sweep is what finishes it.
      expect(mocks.executionTracker.completeRunIfAllJobsTerminal).toHaveBeenCalledWith(
        'run-orphaned',
      );
    });

    it('releases in-memory runs another coordinator finished, on every tick', async () => {
      const mocks = createDeps();
      const detector = new StaleRunDetector(
        makeDeps(createSequentialDb({ selects: [], updates: [] }), mocks),
      );
      await detector.scan();
      // fails-when: nothing on the tick calls the tracker's sweep — a run whose
      // last job a sibling saw stays in this coordinator's memory for the life
      // of the process.
      expect(mocks.executionTracker.pruneRunsFinishedElsewhere).toHaveBeenCalledTimes(1);
    });

    it('leaves a run alone while its window holder is alive', async () => {
      const mocks = createDeps();
      const db = createSequentialDb({
        selects: [
          { executeResult: [] },
          { executeResult: [] },
          { executeResult: [] },
          {
            executeResult: [{ run_id: 'run-held', registration_window_instance_id: 'coord-live' }],
          },
          { executeResult: [{ instance_id: 'coord-live' }] },
        ],
        updates: [],
      });
      const detector = new StaleRunDetector(makeDeps(db, mocks));
      await detector.scan();

      // fails-when: the sweep ignores liveness — it finishes a run on its
      // build job alone while the owner is still registering the real jobs.
      expect(mocks.executionTracker.completeRunIfAllJobsTerminal).not.toHaveBeenCalled();
    });
  });

  /**
   * The `KiCI Security` check the org trust policy's PR-wide hold posted as
   * `pending`. `failRun` writes DB rows and no check run, so an unanswered hold
   * left it `in_progress` on the commit forever.
   */
  describe('scan() completes the security check of an expired hold', () => {
    /** The `execution_runs` row: the pending check's repo, sha, routing key and credentials. */
    const RUN_ROW = {
      repo_identifier: 'acme/app',
      sha: 'cafebabe',
      routing_key: 'github:1',
      provider_context: { installationId: 42 },
    };

    /** Seed a hold on `job_id` + `holdScope`, with a stored dispatch context. */
    async function runExpirySweep(
      jobId: string,
      postCheckStatus: ReturnType<typeof vi.fn>,
      holdScope: string = HoldScope.enum.workflow,
      contenders: unknown[] = [],
    ) {
      const mocks = createDeps();
      const db = createSequentialDb({
        selects: [
          // Sub-scans A, B, C and sweep F, each empty.
          { executeResult: [] },
          { executeResult: [] },
          { executeResult: [] },
          { executeResult: [] },
          // The settler's reads: the run row, then the other holds pending on that commit.
          { executeTakeFirstResult: RUN_ROW },
          { executeResult: contenders },
        ],
        updates: [],
      });

      clearPendingWorkflowContextsMap();
      await storePendingWorkflowContext(undefined, {
        runId: 'run-expiring',
        resolvedOrgId: 'org-7',
        repoIdentifier: 'acme/app',
        ref: 'cafebabe',
        credentials: { installationId: 42 },
        info: { provider: 'github', routingKey: 'github:1' },
        workflow: { name: 'CI', jobs: [{ _type: 'static', name: 'build' }] },
      } as never);

      const heldRunStore = {
        releaseDueWaitHolds: vi.fn().mockResolvedValue([]),
        listOverdue: vi.fn().mockResolvedValue([
          {
            id: 'hold-expiring',
            org_id: 'org-7',
            run_id: 'run-expiring',
            job_id: jobId,
            hold_scope: holdScope,
            hold_type: HoldType.enum.security,
            // An install-gate row carries one (`holdWorkflowForInstallGate` writes it through
            // `createHold`), and that clause would otherwise accept it: without one the row
            // passes even with the install-gate guard removed from the ownership predicate.
            approval_requirement: jobId.startsWith(INSTALL_JOB_ID_PREFIX)
              ? { clauses: [], expiresAt: 'x', reason: 'r' }
              : null,
          },
        ]),
        expireOverdue: vi.fn().mockResolvedValue(1),
      } as unknown as StaleRunDetectorDeps['heldRunStore'];

      const detector = new StaleRunDetector({
        ...makeDeps(db, mocks),
        heldRunStore,
        failRun: vi.fn().mockResolvedValue(undefined),
        resolveCheckStatusPoster: () => ({ postCheckStatus }) as never,
      } as StaleRunDetectorDeps);
      await detector.scan();
      clearPendingWorkflowContextsMap();
      return mocks;
    }

    it('closes it as timed_out, under the same summary the kici/ checks carry', async () => {
      const postCheckStatus = vi.fn().mockResolvedValue(undefined);
      const mocks = await runExpirySweep(SECURITY_HOLD_JOB_IDS.fork_pr, postCheckStatus);

      expect(postCheckStatus).toHaveBeenCalledTimes(1);
      const [repoIdentifier, sha, status, title, summary, credentials] =
        postCheckStatus.mock.calls[0];
      expect(repoIdentifier).toBe('acme/app');
      expect(sha).toBe('cafebabe');
      expect(status).toBe(CheckRunConclusion.enum.timed_out);
      expect(title).toBe('Approval window elapsed');
      expect(summary).toContain('The approval window for this run elapsed');
      // The next step a contributor can actually take.
      expect(summary).toContain('Push a new commit');
      expect(credentials).toEqual({ installationId: 42 });
      // Both check families carry the same summary.
      expect(mocks.checkRunReporter.completeUndispatchedCheckRuns.mock.calls[0][0].summary).toBe(
        summary,
      );
    });

    it('does NOT post one for an expired install-gate hold', async () => {
      // `postCheckStatus` CREATES the named run when absent, and an install-gate hold posts
      // no pending security check, so posting would add a `KiCI Security` check the commit
      // never had. The `kici/…` completion proves only the security post was withheld.
      const postCheckStatus = vi.fn().mockResolvedValue(undefined);
      const mocks = await runExpirySweep(installGateJobId('CI'), postCheckStatus);

      expect(postCheckStatus).not.toHaveBeenCalled();
      expect(mocks.checkRunReporter.completeUndispatchedCheckRuns).toHaveBeenCalledTimes(1);
    });

    it('closes the check of an expired JOB-scoped hold too', async () => {
      // A job-scoped hold posts the same shared check but skips the workflow-only branch; a
      // check left `in_progress` stays so, since the row leaves `pending` and `listOverdue`.
      const postCheckStatus = vi.fn().mockResolvedValue(undefined);
      const mocks = await runExpirySweep('build (18)', postCheckStatus, HoldScope.enum.job);

      expect(postCheckStatus).toHaveBeenCalledTimes(1);
      const [repoIdentifier, sha, status, title, summary] = postCheckStatus.mock.calls[0];
      expect(repoIdentifier).toBe('acme/app');
      expect(sha).toBe('cafebabe');
      expect(status).toBe(CheckRunConclusion.enum.timed_out);
      expect(title).toBe('Approval window elapsed');
      expect(summary).toContain('The approval window for a job in this run elapsed');
      expect(summary).toContain('Push a new commit');
      // No workflow dispatch context, so the `kici/…` family is left to the run's reporting.
      expect(mocks.checkRunReporter.completeUndispatchedCheckRuns).not.toHaveBeenCalled();
    });

    it('settles once for a commit whose whole batch expires in one sweep', async () => {
      // `expireOverdue()` runs AFTER this loop, so the whole batch is still `pending`. Without
      // excluding the batch each hold sees the other as a live contender, neither posts, and
      // the shared check stays `in_progress` forever; tracking the commit avoids a repeat write.
      const postCheckStatus = vi.fn().mockResolvedValue(undefined);
      const mocks = createDeps();
      const overdue = [
        {
          id: 'hold-a',
          org_id: 'org-7',
          run_id: 'run-expiring',
          job_id: 'build (18)',
          hold_scope: HoldScope.enum.job,
          hold_type: HoldType.enum.security,
          approval_requirement: null,
        },
        {
          id: 'hold-b',
          org_id: 'org-7',
          run_id: 'run-expiring',
          job_id: 'build (20)',
          hold_scope: HoldScope.enum.job,
          hold_type: HoldType.enum.security,
          approval_requirement: null,
        },
      ];
      const db = createSequentialDb({
        selects: [
          { executeResult: [] },
          { executeResult: [] },
          { executeResult: [] },
          // hold-a: run row, then the pending set, holding BOTH rows (neither flipped yet).
          { executeTakeFirstResult: RUN_ROW },
          { executeResult: overdue },
          // hold-b: the commit is settled, so it returns before the contention query; the row
          // is configured anyway so dropping the batch exclusion makes hold-b refuse too,
          // rather than pick up the post hold-a was denied.
          { executeTakeFirstResult: RUN_ROW },
          { executeResult: overdue },
        ],
        updates: [],
      });

      const detector = new StaleRunDetector({
        ...makeDeps(db, mocks),
        heldRunStore: {
          releaseDueWaitHolds: vi.fn().mockResolvedValue([]),
          listOverdue: vi.fn().mockResolvedValue(overdue),
          expireOverdue: vi.fn().mockResolvedValue(2),
        } as unknown as StaleRunDetectorDeps['heldRunStore'],
        failRun: vi.fn().mockResolvedValue(undefined),
        resolveCheckStatusPoster: () => ({ postCheckStatus }) as never,
      } as StaleRunDetectorDeps);
      await detector.scan();

      expect(postCheckStatus).toHaveBeenCalledTimes(1);
      expect(postCheckStatus.mock.calls[0][2]).toBe(CheckRunConclusion.enum.timed_out);
    });

    it('leaves it pending while another hold on the same commit still owns it', async () => {
      // One named check per commit: the last remaining hold's ending closes it.
      const postCheckStatus = vi.fn().mockResolvedValue(undefined);
      await runExpirySweep(
        SECURITY_HOLD_JOB_IDS.fork_pr,
        postCheckStatus,
        HoldScope.enum.workflow,
        [
          {
            id: 'hold-sibling',
            org_id: 'org-7',
            run_id: 'run-other',
            job_id: 'build (20)',
            hold_scope: HoldScope.enum.job,
            hold_type: HoldType.enum.security,
            approval_requirement: null,
          },
        ],
      );

      expect(postCheckStatus).not.toHaveBeenCalled();
    });
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
      jobId: installGateJobId('CI'),
      scope: 'workflow',
      stepIndex: null,
      triggerSource: 'context',
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

    expect(mocks.executionTracker.updateInMemoryJob).not.toHaveBeenCalled();
    expect(mocks.checkRunReporter.updateJobStatus).not.toHaveBeenCalled();
    expect(mocks.scalerManager.onAgentDisconnected).not.toHaveBeenCalled();
  });

  it('stale count only includes jobs actually marked (not races lost to agent)', async () => {
    const { setStaleRunsCurrent } = await import('../metrics/prometheus.js');
    const mocks = createDeps();

    // Only one UPDATE succeeds; the other job completed concurrently.
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

    // The gauge counts marked jobs, not SELECT hits.
    expect(setStaleRunsCurrent).toHaveBeenCalledWith(1);

    expect(mocks.executionTracker.completeRunIfAllJobsTerminal).toHaveBeenCalledWith('run-1');
    expect(mocks.executionTracker.completeRunIfAllJobsTerminal).not.toHaveBeenCalledWith('run-2');
  });

  it('scan() continues processing remaining jobs when one job fails to mark (sub-scan A)', async () => {
    const mocks = createDeps();

    // One bad job cannot abort the tick: the per-item try/catch keeps the scan going.
    const job1 = staleJob({ run_id: 'run-1', job_id: 'job-1' });
    const job2 = staleJob({ run_id: 'run-2', job_id: 'job-2' });
    const job3 = staleJob({ run_id: 'run-3', job_id: 'job-3' });

    // updateTable is called in mark order, so the throw lands on job-2 alone.
    let selectCall = 0;
    let updateCall = 0;
    const db = {
      selectFrom: vi.fn(() => {
        const idx = selectCall++;
        if (idx === 0) return createChainableMock({ executeResult: [job1, job2, job3] });
        return createChainableMock({ executeResult: [] });
      }),
      updateTable: vi.fn(() => {
        const idx = updateCall++;
        if (idx === 1) {
          const chain = createChainableMock({});
          chain.executeTakeFirst = vi.fn(async () => {
            throw new Error('DB update failed for job-2');
          });
          return chain;
        }
        return createChainableMock({ executeTakeFirstResult: { numUpdatedRows: 1n } });
      }),
    } as unknown as StaleRunDetectorDeps['db'];

    const detector = new StaleRunDetector(makeDeps(db, mocks));
    await expect(detector.scan()).resolves.toBeUndefined();

    expect(mocks.executionTracker.updateInMemoryJob).toHaveBeenCalledWith(
      'run-1',
      'job-1',
      'timed_out_stale',
    );
    expect(mocks.executionTracker.updateInMemoryJob).toHaveBeenCalledWith(
      'run-3',
      'job-3',
      'timed_out_stale',
    );
    expect(mocks.executionTracker.updateInMemoryJob).not.toHaveBeenCalledWith(
      'run-2',
      'job-2',
      'timed_out_stale',
    );

    expect(mocks.executionTracker.completeRunIfAllJobsTerminal).toHaveBeenCalledWith('run-1');
    expect(mocks.executionTracker.completeRunIfAllJobsTerminal).toHaveBeenCalledWith('run-3');
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

    expect(mocks.executionTracker.updateInMemoryJob).toHaveBeenCalledWith(
      'run-1',
      'job-1',
      'timed_out_stale',
    );

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

    // execution_jobs is updated too (propagation).
    expect((db as any).updateTable).toHaveBeenCalledTimes(2);

    expect(mocks.executionTracker.updateInMemoryJob).toHaveBeenCalledWith(
      'run-2',
      'ejob-2',
      'timed_out_stale',
    );

    expect(mocks.executionTracker.completeRunIfAllJobsTerminal).toHaveBeenCalledWith('run-2');
  });

  it('scan() calls completeRunIfAllJobsTerminal for affected runs', async () => {
    const mocks = createDeps();

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

    expect(mocks.executionTracker.completeRunIfAllJobsTerminal).toHaveBeenCalledWith('run-1');
    expect(mocks.executionTracker.completeRunIfAllJobsTerminal).toHaveBeenCalledWith('run-2');
  });

  it('crash recovery: completeRunIfAllJobsTerminal called for affected runs', async () => {
    // Post-restart, completeRunIfAllJobsTerminal takes its DB-fallback path (tested in
    // execution-tracker.test.ts) because in-memory state is empty.
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

    vi.mocked((db as any).selectFrom).mockClear();

    detector.stop();

    vi.advanceTimersByTime(120_000);

    expect((db as any).selectFrom).not.toHaveBeenCalled();
  });

  it('force-terminates agent via scalerManager', async () => {
    const mocks = createDeps();
    const job = staleJob({ agent_id: 'agent-99' });
    mocks.dispatcher.getAgentIdForJob.mockImplementation((jobId) =>
      jobId === job.job_id ? 'agent-99' : null,
    );

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

    // The mock has no onJobStatus, so a call would throw.
    expect(mocks.executionTracker).not.toHaveProperty('onJobStatus');
    expect(mocks.executionTracker.updateInMemoryJob).toHaveBeenCalled();
  });

  it('cleanupOrphanedRecoveryJobs() checks run completion for affected runs', async () => {
    const mocks = createDeps();

    // Select recovering jobs, then fail execution_jobs and dispatch_queue.
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

    await expect(detector.scan()).resolves.toBeUndefined();
  });

  // fails-when: the detector disconnects the agent the row names although this
  // dispatcher no longer tracks the stale job to it — the agent reconnected and
  // runs another job, which the disconnect would push into a recovery that never
  // ends, and the agent would be dropped from the registry with its socket open.
  it('leaves a reconnected agent alone when the dispatcher no longer tracks the stale job to it', async () => {
    const mocks = createDeps();
    const job = staleJob({ agent_id: 'agent-1' });
    mocks.dispatcher.getAgentIdForJob.mockReturnValue(null);

    const db = createSequentialDb({
      selects: [{ executeResult: [job] }, { executeResult: [] }, { executeResult: [] }],
      updates: [{ executeTakeFirstResult: { numUpdatedRows: 1n } }],
    });

    const detector = new StaleRunDetector(makeDeps(db, mocks));
    await detector.scan();

    expect(mocks.executionTracker.updateInMemoryJob).toHaveBeenCalledWith(
      job.run_id,
      job.job_id,
      'timed_out_stale',
    );
    expect(mocks.dispatcher.onAgentDisconnect).not.toHaveBeenCalled();
  });

  // breaks-if-wrong: an agent that still holds the stale job is force-terminated
  it('disconnects an agent the dispatcher still tracks the stale job to', async () => {
    const mocks = createDeps();
    const job = staleJob({ agent_id: 'agent-1' });
    mocks.dispatcher.getAgentIdForJob.mockReturnValue('agent-1');

    const db = createSequentialDb({
      selects: [{ executeResult: [job] }, { executeResult: [] }, { executeResult: [] }],
      updates: [{ executeTakeFirstResult: { numUpdatedRows: 1n } }],
    });

    const detector = new StaleRunDetector(makeDeps(db, mocks));
    await detector.scan();

    expect(mocks.dispatcher.onAgentDisconnect).toHaveBeenCalledWith('agent-1');
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

describe('StaleRunDetector — the reaped job carries the run trust posture', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('forwards the run trust posture onto a reaped job check-run completion', async () => {
    // On a degraded fork run the reap's completion check is one of only two the contributor
    // gets, so dropping the posture hides the explanation where it is most needed.
    const mocks = createDeps();
    const db = createSequentialDb({
      selects: [
        { executeResult: [staleJob({ trust_tier: 'unknown', lock_file_source: 'base' })] },
        { executeResult: [] },
        { executeResult: [] },
      ],
      updates: [{ executeTakeFirstResult: { numUpdatedRows: 1n } }],
    });

    const detector = new StaleRunDetector(makeDeps(db, mocks));
    await detector.scan();

    expect(mocks.checkRunReporter.updateJobStatus).toHaveBeenCalledWith(
      expect.objectContaining({ trustTier: 'unknown', lockFileSource: 'base' }),
    );
  });

  it('omits both fields for a run whose trust never resolved', async () => {
    // Positive control: NULL trust columns forward nothing, so the test above is not passing
    // on a harness that echoes the fields unconditionally.
    const mocks = createDeps();
    const db = createSequentialDb({
      selects: [
        { executeResult: [staleJob({ trust_tier: null, lock_file_source: null })] },
        { executeResult: [] },
        { executeResult: [] },
      ],
      updates: [{ executeTakeFirstResult: { numUpdatedRows: 1n } }],
    });

    const detector = new StaleRunDetector(makeDeps(db, mocks));
    await detector.scan();

    const opts = mocks.checkRunReporter.updateJobStatus.mock.calls[0][0];
    expect(opts).not.toHaveProperty('trustTier');
    expect(opts).not.toHaveProperty('lockFileSource');
  });
});
