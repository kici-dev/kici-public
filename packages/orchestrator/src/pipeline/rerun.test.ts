import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleRerun, type RerunDeps } from './rerun.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';

// --- Mock helpers ---

function makeMockDb(run?: Record<string, unknown>) {
  return createMockDb({ selectFirstRow: run ?? null }).db;
}

function createMockLogStorage(payloadData: string | null = null) {
  return {
    append: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue({ data: payloadData ?? '', cursor: 0, complete: true }),
    exists: vi.fn().mockResolvedValue(payloadData !== null),
    list: vi.fn().mockResolvedValue([]),
  };
}

function createMockDispatcher() {
  return {
    dispatch: vi.fn().mockResolvedValue({ status: 'dispatched', agentId: 'agent-1', jobId: 'j1' }),
    onAgentAvailable: vi.fn().mockResolvedValue(undefined),
    onJobComplete: vi.fn(),
    getAgentIdForJob: vi.fn().mockReturnValue(null),
  };
}

function createMockExecutionTracker() {
  return {
    onExecutionStarted: vi.fn().mockResolvedValue(undefined),
    onJobStatus: vi.fn().mockResolvedValue(undefined),
    addJobsToRun: vi.fn().mockResolvedValue(undefined),
    getExecutionContext: vi.fn().mockReturnValue(null),
    getJobName: vi.fn().mockReturnValue(null),
  };
}

function createMockProviderBundle() {
  return {
    normalizer: {
      provider: 'github' as const,
      normalizeEvent: vi.fn(),
      extractRoutingKey: vi.fn(),
      extractDeliveryId: vi.fn(),
      extractEventType: vi.fn(),
      verifySignature: vi.fn(),
    },
    lockFileFetcher: {
      provider: 'github' as const,
      fetchLockFile: vi.fn().mockResolvedValue(null),
    },
    repoUrlBuilder: {
      provider: 'github' as const,
      buildCloneUrl: vi.fn().mockImplementation((id: string) => `https://github.com/${id}.git`),
      buildRawFileUrl: vi.fn(),
    },
  };
}

function createMockProviderRegistry(bundle: ReturnType<typeof createMockProviderBundle> | null) {
  return {
    get: vi.fn().mockReturnValue(bundle),
    getByRoutingKey: vi.fn().mockReturnValue(bundle),
  };
}

function createMockPlatformClient() {
  return {
    send: vi.fn(),
    sendRaw: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    state: 'authenticated' as const,
    getBufferedCount: vi.fn().mockReturnValue(0),
  };
}

function createMockJobQueue() {
  return {
    enqueue: vi.fn().mockResolvedValue('job-1'),
    getDispatchedJobIdsByRunId: vi.fn().mockResolvedValue([]),
    insertDispatched: vi.fn().mockResolvedValue('job-1'),
    dequeueForLabels: vi.fn().mockResolvedValue(null),
    getDepth: vi.fn().mockResolvedValue(0),
  };
}

function createMockAgentRegistry() {
  return {
    findAvailable: vi.fn().mockReturnValue([
      {
        agentId: 'a1',
        labels: new Set(['default']),
        activeJobs: 0,
        maxConcurrency: 4,
        platform: 'linux',
        arch: 'x64',
      },
    ]),
    get: vi.fn().mockReturnValue(null),
    getAllEntries: vi.fn().mockReturnValue([]),
  };
}

const TERMINAL_RUN = {
  id: 'gen-id',
  run_id: 'original-run-123',
  routing_key: 'github:42',
  workflow_name: 'ci',
  status: 'success',
  provider: 'github',
  repo_identifier: 'owner/repo',
  ref: 'main',
  sha: 'abc123def',
  delivery_id: 'del-1',
  trigger_decision: null,
  started_at: new Date('2026-01-01'),
  completed_at: new Date('2026-01-01T00:01:00'),
  duration_ms: 60000,
  provider_context: JSON.stringify({ installationId: 42 }),
  is_test_run: false,
  fixture_id: null,
  parent_run_id: null,
  triggered_by: null,
  cancelled_by: null,
  created_at: new Date('2026-01-01'),
};

const LOCK_FILE = {
  version: 2,
  source: '.kici/workflows/ci.ts',
  lockfileHash: 'hash123',
  workflows: [
    {
      name: 'ci',
      source: '.kici/workflows/ci.ts',
      contentHash: 'content-hash-1',
      triggers: [{ _type: 'push', branches: ['main'] }],
      jobs: [
        {
          _type: 'static',
          name: 'test',
          runsOn: 'default',
          steps: [{ name: 'run tests', run: 'npm test' }],
          needs: [],
        },
      ],
    },
  ],
};

const PAYLOAD = {
  repository: { full_name: 'owner/repo' },
  ref: 'refs/heads/main',
  after: 'abc123def',
};

describe('handleRerun', () => {
  let deps: RerunDeps;
  let db: any;
  let logStorage: ReturnType<typeof createMockLogStorage>;
  let providerBundle: ReturnType<typeof createMockProviderBundle>;
  let dispatcher: ReturnType<typeof createMockDispatcher>;
  let executionTracker: ReturnType<typeof createMockExecutionTracker>;
  let platformClient: ReturnType<typeof createMockPlatformClient>;
  let eventRouter: { emit: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    db = makeMockDb(TERMINAL_RUN);
    logStorage = createMockLogStorage(JSON.stringify(PAYLOAD));
    providerBundle = createMockProviderBundle();
    providerBundle.lockFileFetcher!.fetchLockFile.mockResolvedValue(LOCK_FILE);
    dispatcher = createMockDispatcher();
    executionTracker = createMockExecutionTracker();
    platformClient = createMockPlatformClient();
    eventRouter = { emit: vi.fn().mockResolvedValue(undefined) };

    deps = {
      db: db as any,
      logStorage: logStorage as any,
      providerRegistry: createMockProviderRegistry(providerBundle) as any,
      executionTracker: executionTracker as any,
      dispatcher: dispatcher as any,
      jobQueue: createMockJobQueue() as any,
      platformClient: platformClient as any,
      checkRunReporter: null,
      coordinator: null,
      secretResolver: null,
      eventRouter: eventRouter as any,
      agentRegistry: createMockAgentRegistry() as any,
      sourceCache: null,
      depCache: null,
      buildCoordinator: null,
      pendingBuilds: null,
      coldStore: null,
    };
  });

  it('loads original run from DB, reads payload, re-fetches lock file, dispatches jobs with parent_run_id', async () => {
    const result = await handleRerun('original-run-123', 'user@test.com', deps);

    // Should have a newRunId
    expect(result.newRunId).toBeDefined();
    expect(typeof result.newRunId).toBe('string');

    // Should read payload from storage
    expect(logStorage.read).toHaveBeenCalledWith(
      'executions/original-run-123/webhook-payload.json',
    );

    // Should re-fetch lock file at original SHA
    expect(providerBundle.lockFileFetcher!.fetchLockFile).toHaveBeenCalledWith(
      'owner/repo',
      'abc123def',
      expect.objectContaining({ installationId: 42 }),
    );

    // Should dispatch jobs
    expect(dispatcher.dispatch).toHaveBeenCalled();
    const dispatchArg = dispatcher.dispatch.mock.calls[0][0];
    expect(dispatchArg.workflowName).toBe('ci');
    expect(dispatchArg.sha).toBe('abc123def');

    // Should track execution with parent_run_id (via executionTracker.onExecutionStarted)
    expect(executionTracker.onExecutionStarted).toHaveBeenCalled();
  });

  it('re-materializes a matrix job into N dispatches each carrying matrixValues', async () => {
    providerBundle.lockFileFetcher!.fetchLockFile.mockResolvedValue({
      ...LOCK_FILE,
      workflows: [
        {
          name: 'ci',
          source: '.kici/workflows/ci.ts',
          contentHash: 'content-hash-1',
          triggers: [{ _type: 'push', branches: ['main'] }],
          jobs: [
            {
              _type: 'static',
              name: 'test',
              runsOn: 'default',
              steps: [{ name: 'run tests', run: 'npm test' }],
              needs: [],
              matrix: { _type: 'static', values: { variant: ['a', 'b'] } },
            },
          ],
        },
      ],
    });

    await handleRerun('original-run-123', 'user@test.com', deps);

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
    const calls = dispatcher.dispatch.mock.calls.map((c: any[]) => c[0]);
    const byName = Object.fromEntries(calls.map((c: any) => [c.jobName, c]));
    expect(Object.keys(byName).sort()).toEqual(['test (a)', 'test (b)']);
    expect(byName['test (a)'].jobConfig.matrixValues).toEqual({ variant: 'a' });
    expect(byName['test (b)'].jobConfig.matrixValues).toEqual({ variant: 'b' });
    expect(byName['test (a)'].jobConfig.baseJobName).toBe('test');
    expect(byName['test (a)'].jobConfig.matrix).toBeUndefined();
  });

  it('fails with error if run is not in terminal state (running -> error)', async () => {
    const runningRun = { ...TERMINAL_RUN, status: 'running' };
    db = makeMockDb(runningRun);
    deps.db = db as any;

    await expect(handleRerun('original-run-123', null, deps)).rejects.toThrow(
      'Run is not in a terminal state (current: running)',
    );
  });

  it('rejects cancelling state (non-terminal despite containing "cancel")', async () => {
    const cancellingRun = { ...TERMINAL_RUN, status: 'cancelling' };
    db = makeMockDb(cancellingRun);
    deps.db = db as any;

    await expect(handleRerun('original-run-123', null, deps)).rejects.toThrow(
      'Run is not in a terminal state (current: cancelling)',
    );
  });

  it('succeeds with no payload (cron/schedule runs) — no payload stored for new run', async () => {
    // Simulate a cron/schedule run that has no webhook payload
    logStorage = createMockLogStorage(null);
    logStorage.read.mockResolvedValue({ data: null, cursor: 0, complete: true });
    deps.logStorage = logStorage as any;

    const result = await handleRerun('original-run-123', null, deps);

    // Should succeed
    expect(result.newRunId).toBeDefined();

    // Should NOT store a payload for the new run
    expect(logStorage.append).not.toHaveBeenCalled();

    // Should still dispatch jobs
    expect(dispatcher.dispatch).toHaveBeenCalled();

    // commitMessage should be undefined (no payload to extract from)
    const trackerCall = executionTracker.onExecutionStarted.mock.calls[0];
    // commitMessage is arg 13 (0-indexed)
    expect(trackerCall[13]).toBeUndefined();
  });

  it('fails with error if lock file not found at original SHA', async () => {
    providerBundle.lockFileFetcher!.fetchLockFile.mockResolvedValue(null);

    await expect(handleRerun('original-run-123', null, deps)).rejects.toThrow(
      'Lock file not found at original SHA',
    );
  });

  it('throws RunArchivedNotRerunnableError on PG miss when cold-store cannot replay', async () => {
    // Phase F: PG miss now goes through cold-store replay before failing.
    // With deps.coldStore=null (the default test harness) replay is skipped
    // and the gate surfaces the structured archive error so the Platform
    // proxy can map to HTTP 410.
    db = makeMockDb(null);
    deps.db = db as any;

    await expect(handleRerun('nonexistent', null, deps)).rejects.toThrow(
      /archived to cold storage|chunk could not be replayed/,
    );
  });

  it('fails if test run', async () => {
    db = makeMockDb({ ...TERMINAL_RUN, is_test_run: true });
    deps.db = db as any;

    await expect(handleRerun('original-run-123', null, deps)).rejects.toThrow(
      'Test runs cannot be re-run',
    );
  });

  it('passes parentRunId and triggeredBy to executionTracker.onExecutionStarted', async () => {
    const result = await handleRerun('original-run-123', 'user@test.com', deps);

    // executionTracker.onExecutionStarted should have been called with parentRunId and triggeredBy
    // as the last two positional arguments
    expect(executionTracker.onExecutionStarted).toHaveBeenCalled();
    const call = executionTracker.onExecutionStarted.mock.calls[0];
    // parentRunId is arg 14 (0-indexed), triggeredBy is arg 15
    expect(call[14]).toBe('original-run-123'); // parentRunId
    expect(call[15]).toBe('user@test.com'); // triggeredBy

    expect(result.newRunId).toBeDefined();
  });

  it('passes different triggeredBy values correctly', async () => {
    await handleRerun('original-run-123', 'admin@company.com', deps);

    expect(executionTracker.onExecutionStarted).toHaveBeenCalled();
    const call = executionTracker.onExecutionStarted.mock.calls[0];
    expect(call[14]).toBe('original-run-123'); // parentRunId
    expect(call[15]).toBe('admin@company.com'); // triggeredBy
  });

  it('emits workflow.rerun system event via EventRouter', async () => {
    await handleRerun('original-run-123', 'user@test.com', deps);

    expect(eventRouter.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: 'workflow.rerun',
        payload: expect.objectContaining({
          parentRunId: 'original-run-123',
          workflowName: 'ci',
        }),
      }),
    );
  });

  it('dispatches jobs using the existing Dispatcher infrastructure', async () => {
    const result = await handleRerun('original-run-123', null, deps);

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);

    const arg = dispatcher.dispatch.mock.calls[0][0];
    expect(arg.runId).toBe(result.newRunId);
    expect(arg.workflowName).toBe('ci');
    expect(arg.jobName).toBe('test');
    expect(arg.repoUrl).toBe('https://github.com/owner/repo.git');
    expect(arg.sha).toBe('abc123def');
    expect(arg.ref).toBe('main');
  });

  it('stores payload for the new run', async () => {
    const result = await handleRerun('original-run-123', null, deps);

    // Should store payload for the new run too
    expect(logStorage.append).toHaveBeenCalledWith(
      `executions/${result.newRunId}/webhook-payload.json`,
      JSON.stringify(PAYLOAD),
    );
  });

  it('routes via the cluster coordinator when one is available (cross-peer rerun)', async () => {
    // Coordinator stubbed so it answers with one locally-dispatched job and one
    // rerouted to a peer. This is the exact failure mode from staging: the
    // Platform proxies the rerun to a peer that cannot satisfy the labels, and
    // without coordinator routing the job sits in dispatch_queue forever.
    const coordinator = {
      routeJobs: vi.fn().mockResolvedValue({
        localJobs: [{ jobName: 'test', jobId: 'local-job-1' }],
        reroutedJobs: [{ jobName: 'other', peerId: 'host-1-stg' }],
        failedJobs: [],
      }),
    };
    deps.coordinator = coordinator as any;

    await handleRerun('original-run-123', 'user@test.com', deps);

    // Coordinator was asked to route the jobs
    expect(coordinator.routeJobs).toHaveBeenCalledOnce();
    const [runCtx, jobs] = coordinator.routeJobs.mock.calls[0];
    expect(runCtx.routingKey).toBe('github:42');
    expect(runCtx.event).toBe('rerun');
    expect(runCtx.sha).toBe('abc123def');
    expect(runCtx.ref).toBe('main');
    expect(runCtx.installationId).toBe(42);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].jobName).toBe('test');
    expect(jobs[0].ref).toBe('main');
    expect(jobs[0].sha).toBe('abc123def');
    // Inner labels are double-wrapped as required by RunCoordinator
    expect(jobs[0].runsOnLabels).toEqual([['default']]);

    // Standalone direct dispatch was NOT called — coordinator owns dispatch
    expect(dispatcher.dispatch).not.toHaveBeenCalled();

    // Locally-dispatched job id is registered with the tracker
    expect(executionTracker.addJobsToRun).toHaveBeenCalledOnce();
    const addArgs = executionTracker.addJobsToRun.mock.calls[0];
    expect(typeof addArgs[0]).toBe('string');
    expect(addArgs[1]).toEqual([
      { jobId: 'local-job-1', jobName: 'test', runsOnLabels: ['default'] },
    ]);
  });

  // ── `run.rerun.request` orchestrator-side trust model (security invariant) ──
  //
  // Pentest catalog at
  // — Platform→Orchestrator dispatch surface under attacker model A10 (compromised
  // Platform credential / rogue Platform process). The orchestrator's rerun
  // pipeline trusts Platform on user-identity attribution (`actor` / `triggeredBy`
  // are Platform-supplied; orch has no independent OIDC trust to Keycloak) — that
  // is by-design under the 3-tier auth model and out of scope here. The
  // tenant-isolation invariants below ARE in scope; the tests pin them so a
  // future regression that erodes them shows up as a loud test failure.
  describe('tenant-isolation invariants under rogue Platform (A10)', () => {
    it('rejects with RunArchivedNotRerunnableError when cold-store is wired but returns chunkId=null', async () => {
      // Tenant-isolation invariant 1: a runId Platform names that is missing
      // from the orchestrator DB AND has no cold-store match must NOT lead to
      // any dispatch — neither a dispatched job nor a recorded execution-start
      // row. Today's behavior throws `RunArchivedNotRerunnableError` before
      // any of those side effects fire. The existing test at line ~280 covers
      // the `coldStore = null` branch; this test covers the `coldStore wired
      // but returns chunkId=null` branch (cold-store reachable, but no
      // manifest matches the rowId / tenantId pair Platform supplied).
      db = makeMockDb(null);
      deps.db = db as any;
      const replayRow = vi.fn().mockResolvedValue({ inserted: 0, skipped: 0, chunkId: null });
      deps.coldStore = { replayRow } as unknown as RerunDeps['coldStore'];

      await expect(
        handleRerun('forged-runid-not-in-db', null, deps, 'attacker-supplied-routing-key'),
      ).rejects.toThrow(/archived to cold storage|chunk could not be replayed/);

      // Side-effect-free: nothing got dispatched; nothing got recorded.
      expect(dispatcher.dispatch).not.toHaveBeenCalled();
      expect(executionTracker.onExecutionStarted).not.toHaveBeenCalled();
      expect(executionTracker.addJobsToRun).not.toHaveBeenCalled();
      expect(eventRouter.emit).not.toHaveBeenCalled();

      // Cold-store WAS consulted with Platform-supplied routingKeyHint as
      // tenantId — that IS the tenant-scoped lookup. Cross-orch isolation
      // here holds at the AWS-IAM layer (each orchestrator has its own
      // KICI_COLD_STORE_BUCKET / KICI_COLD_STORE_PREFIX env-config), so this
      // tenantId can only point at the orchestrator's own bucket prefix.
      expect(replayRow).toHaveBeenCalledWith(
        expect.objectContaining({
          db: 'orchestrator',
          table: 'execution_runs',
          tenantId: 'attacker-supplied-routing-key',
          rowId: 'forged-runid-not-in-db',
        }),
      );
    });

    it('downstream operations use originalRun.routing_key, not Platform-supplied routingKeyHint', async () => {
      // Tenant-isolation invariant 3: once `loadAndValidateOriginalRun`
      // returns a row, every subsequent operation MUST authority-derive
      // from `originalRun.routing_key` (read from the orchestrator's own
      // DB), NOT from the Platform-supplied `routingKeyHint`. This is what
      // pins the trust boundary post-load: even if Platform fakes a
      // routingKeyHint to bias the cold-store lookup (invariant 1 above
      // already shows the cold-store is per-orchestrator-scoped, but
      // defense-in-depth), the rerun executes against the lock file +
      // provider bundle for the run's OWN routing key, not the attacker's
      // chosen one.
      const realKey = 'github:42';
      const attackerHint = 'github:99-rogue';
      db = makeMockDb({ ...TERMINAL_RUN, routing_key: realKey });
      deps.db = db as any;

      await handleRerun('original-run-123', null, deps, attackerHint);

      // The provider bundle resolution MUST have been keyed by the run's
      // own routing_key, not the Platform-supplied hint.
      const getByRoutingKey = (
        deps.providerRegistry as unknown as { getByRoutingKey: ReturnType<typeof vi.fn> }
      ).getByRoutingKey;
      const callArgs = getByRoutingKey.mock.calls.map((c) => c[0]);
      expect(callArgs).toContain(realKey);
      expect(callArgs).not.toContain(attackerHint);

      // The dispatched job's repoUrl MUST derive from the run's own
      // (provider-bundle-resolved) routing key, not the attacker's hint.
      // The mock buildCloneUrl echoes the repo identifier, so this test
      // confirms the dispatch reached the legitimate provider bundle.
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
      const dispatchedJob = dispatcher.dispatch.mock.calls[0][0];
      expect(dispatchedJob.repoUrl).toBe('https://github.com/owner/repo.git');
    });
  });
});
