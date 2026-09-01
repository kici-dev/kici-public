import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { handleRerun, settlePendingRoundReevaluations, type RerunDeps } from './rerun.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';

// The generic mock DB cannot enforce real `INSERT … ON CONFLICT` dedup
// semantics (that is covered against a real Postgres in
// `request-idempotency.test.ts`). Here we mock the claim with an in-memory
// stateful implementation so `handleRerun`'s wiring — a `claimed: false`
// re-send short-circuits before dispatch — is exercised deterministically.
const idempotency = vi.hoisted(() => {
  const claims = new Map<string, string>();
  let counter = 0;
  return {
    reset: () => {
      claims.clear();
      counter = 0;
    },
    claim: (requestId: string): { newRunId: string; claimed: boolean } => {
      const existing = claims.get(requestId);
      if (existing) return { newRunId: existing, claimed: false };
      const id = `mock-newrun-${++counter}`;
      claims.set(requestId, id);
      return { newRunId: id, claimed: true };
    },
  };
});

vi.mock('./request-idempotency.js', () => ({
  claimRequestId: vi.fn(async (_db: unknown, requestId: string) => idempotency.claim(requestId)),
  pruneRequestIdempotency: vi.fn(async () => 0),
}));

// The organization-wide pass is driven end-to-end by its own suite
// (`process-webhook-globals-eval-round.test.ts`). Here it is stubbed so the
// round-rerun tests observe WHAT the rerun asks it to do — the scope, the
// repository, the commit — rather than re-testing the pass itself. Everything
// else in `process-webhook.js` stays real.
const globalsPass = vi.hoisted(() => ({
  impl: null as null | ((args: Record<string, unknown>) => Promise<unknown>),
}));

vi.mock('./process-webhook.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./process-webhook.js')>();
  return {
    ...actual,
    dispatchGlobalWorkflowsForOtherRepos: (args: Record<string, unknown>) =>
      globalsPass.impl!(args),
  };
});

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
      extractCredentials: vi.fn().mockReturnValue({}),
      isDefaultBranchPush: vi.fn().mockReturnValue(false),
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
    insertDispatched: vi.fn().mockResolvedValue({ id: 'job-1', inserted: true }),
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
          runsOn: [{ kind: 'exact', value: 'default' }],
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
    idempotency.reset();
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
    const result = await handleRerun('original-run-123', 'user@test.com', null, deps, 'req-test');

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

  it('is idempotent on requestId: a failover re-send returns the same run without a second dispatch', async () => {
    const requestId = 'req-dedupe-1';
    const first = await handleRerun('original-run-123', 'user@test.com', null, deps, requestId);
    const second = await handleRerun('original-run-123', 'user@test.com', null, deps, requestId);

    // Same run id, not a freshly-minted second run.
    expect(second.newRunId).toBe(first.newRunId);
    // Only the first hop created + dispatched the run; the re-send short-circuits.
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(executionTracker.onExecutionStarted).toHaveBeenCalledTimes(1);
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
              runsOn: [{ kind: 'exact', value: 'default' }],
              steps: [{ name: 'run tests', run: 'npm test' }],
              needs: [],
              matrix: { _type: 'static', values: { variant: ['a', 'b'] } },
            },
          ],
        },
      ],
    });

    await handleRerun('original-run-123', 'user@test.com', null, deps, 'req-test');

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

    await expect(handleRerun('original-run-123', null, null, deps, 'req-test')).rejects.toThrow(
      'Run is not in a terminal state (current: running)',
    );
  });

  it('rejects cancelling state (non-terminal despite containing "cancel")', async () => {
    const cancellingRun = { ...TERMINAL_RUN, status: 'cancelling' };
    db = makeMockDb(cancellingRun);
    deps.db = db as any;

    await expect(handleRerun('original-run-123', null, null, deps, 'req-test')).rejects.toThrow(
      'Run is not in a terminal state (current: cancelling)',
    );
  });

  it('succeeds with no payload (cron/schedule runs) — no payload stored for new run', async () => {
    // Simulate a cron/schedule run that has no webhook payload
    logStorage = createMockLogStorage(null);
    logStorage.read.mockResolvedValue({ data: null, cursor: 0, complete: true });
    deps.logStorage = logStorage as any;

    const result = await handleRerun('original-run-123', null, null, deps, 'req-test');

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

    await expect(handleRerun('original-run-123', null, null, deps, 'req-test')).rejects.toThrow(
      'Lock file not found at original SHA',
    );
  });

  describe('an organization-wide run that executed against another repository', () => {
    /**
     * `repo_identifier` names the repository the run acted on. For an
     * organization-wide workflow that is the SOURCE repository, while the
     * workflow itself lives in `workflow_repo_identifier`. Everything below
     * `loadAndValidateOriginalRun` resolves the workflow out of
     * `repo_identifier`'s lock file, so a rerun would fetch the wrong repo.
     */
    const GLOBAL_RUN = {
      ...TERMINAL_RUN,
      workflow_name: 'org-ci',
      repo_identifier: 'owner/source-repo',
      workflow_repo_identifier: 'owner/org-workflows',
    };

    it('is refused, naming both repositories', async () => {
      deps.db = makeMockDb(GLOBAL_RUN) as any;

      await expect(handleRerun('original-run-123', null, null, deps, 'req-test')).rejects.toThrow(
        /Cannot re-run an organization-wide workflow: 'org-ci' is defined in owner\/org-workflows but this run executed against owner\/source-repo/,
      );
    });

    it('is refused BEFORE anything is fetched, claimed or dispatched', async () => {
      deps.db = makeMockDb(GLOBAL_RUN) as any;

      await expect(handleRerun('original-run-123', null, null, deps, 'req-test')).rejects.toThrow(
        /Cannot re-run an organization-wide workflow/,
      );

      // The whole point of refusing: the lock fetch that would have resolved
      // the WRONG repository's workflow never happens, so a same-named
      // workflow in the source repository cannot be run in its place.
      expect(providerBundle.lockFileFetcher!.fetchLockFile).not.toHaveBeenCalled();
      expect(dispatcher.dispatch).not.toHaveBeenCalled();
      expect(executionTracker.onExecutionStarted).not.toHaveBeenCalled();
      expect(executionTracker.addJobsToRun).not.toHaveBeenCalled();
      expect(eventRouter.emit).not.toHaveBeenCalled();
    });

    it("would otherwise have silently run the source repo's same-named workflow", async () => {
      // The positive control for the refusal above, and the record of what it
      // prevents: with the marker absent the run is indistinguishable from a
      // per-repository one, so the source repository's lock file resolves and
      // its own `org-ci` is what executes.
      const { workflow_repo_identifier: _dropped, ...unmarked } = GLOBAL_RUN;
      deps.db = makeMockDb({ ...unmarked, workflow_name: 'ci' }) as any;

      await handleRerun('original-run-123', null, null, deps, 'req-test');

      expect(providerBundle.lockFileFetcher!.fetchLockFile).toHaveBeenCalledWith(
        'owner/source-repo',
        'abc123def',
        expect.anything(),
      );
      expect(dispatcher.dispatch).toHaveBeenCalled();
    });

    it('allows a rerun when the workflow lives in the repository the run acted on', async () => {
      // A same-repo value is not a cross-repo dispatch and must not be
      // refused — otherwise the guard would block ordinary reruns the moment
      // anything started populating the column unconditionally.
      deps.db = makeMockDb({
        ...TERMINAL_RUN,
        workflow_repo_identifier: TERMINAL_RUN.repo_identifier,
      }) as any;

      await handleRerun('original-run-123', null, null, deps, 'req-test');

      expect(dispatcher.dispatch).toHaveBeenCalled();
    });
  });

  it('throws RunArchivedNotRerunnableError on PG miss when cold-store cannot replay', async () => {
    // Phase F: PG miss now goes through cold-store replay before failing.
    // With deps.coldStore=null (the default test harness) replay is skipped
    // and the gate surfaces the structured archive error so the Platform
    // proxy can map to HTTP 410.
    db = makeMockDb(null);
    deps.db = db as any;

    await expect(handleRerun('nonexistent', null, null, deps, 'req-test')).rejects.toThrow(
      /archived to cold storage|chunk could not be replayed/,
    );
  });

  it('fails if test run', async () => {
    db = makeMockDb({ ...TERMINAL_RUN, is_test_run: true });
    deps.db = db as any;

    await expect(handleRerun('original-run-123', null, null, deps, 'req-test')).rejects.toThrow(
      'Test runs cannot be re-run',
    );
  });

  it('passes parentRunId and triggeredBy to executionTracker.onExecutionStarted', async () => {
    const result = await handleRerun('original-run-123', 'user@test.com', null, deps, 'req-test');

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
    await handleRerun('original-run-123', 'admin@company.com', null, deps, 'req-test');

    expect(executionTracker.onExecutionStarted).toHaveBeenCalled();
    const call = executionTracker.onExecutionStarted.mock.calls[0];
    expect(call[14]).toBe('original-run-123'); // parentRunId
    expect(call[15]).toBe('admin@company.com'); // triggeredBy
  });

  it('emits workflow.rerun system event via EventRouter', async () => {
    await handleRerun('original-run-123', 'user@test.com', null, deps, 'req-test');

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
    const result = await handleRerun('original-run-123', null, null, deps, 'req-test');

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
    const result = await handleRerun('original-run-123', null, null, deps, 'req-test');

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

    await handleRerun('original-run-123', 'user@test.com', null, deps, 'req-test');

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
        handleRerun(
          'forged-runid-not-in-db',
          null,
          null,
          deps,
          'req-test',
          'attacker-supplied-routing-key',
        ),
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

      await handleRerun('original-run-123', null, null, deps, 'req-test', attackerHint);

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

  /**
   * Re-running a failed global evaluation round re-evaluates the original event.
   *
   * A round decides which organization-wide workflows apply to an event; a round
   * that fails suppresses every workflow it was deciding on and is recorded as
   * one errored run. Re-running that run re-drives the evaluation for the round's
   * own workflow repository — it resolves no workflow out of a lock file, so the
   * cross-repository refusal (which exists to stop exactly that) does not apply.
   */
  describe('re-running a failed global evaluation round', () => {
    const SOURCE_REPO = 'owner/source-repo';
    const WORKFLOW_REPO = 'owner/org-workflows';

    /**
     * The round's run row.
     *
     * It also carries the `event` / `action` / `org_id` columns the delivery's
     * `event_log` row holds: the mock DB serves one configured row to every
     * select whose predicates it satisfies, and both queries filter on values
     * this row declares. `org_id` matching `customer_id` is what makes the
     * org-scoped delivery lookup find it — a fixture whose `org_id` names
     * another tenant is the regression case below.
     */
    const ROUND_RUN = {
      ...TERMINAL_RUN,
      status: 'failed',
      workflow_name: '__globaleval__owner/org-workflows',
      repo_identifier: SOURCE_REPO,
      workflow_repo_identifier: WORKFLOW_REPO,
      is_global_eval_round: true,
      customer_id: 'org-1',
      delivery_id: 'del-round-1',
      org_id: 'org-1',
      event: 'push',
      action: null,
    };

    let dispatchGlobals: Mock<(args: Record<string, unknown>) => Promise<unknown>>;
    let postSucceeded: Mock<(...args: unknown[]) => Promise<void>>;
    let normalizeEvent: Mock<(...args: unknown[]) => unknown>;

    beforeEach(() => {
      dispatchGlobals = vi
        .fn<(args: Record<string, unknown>) => Promise<unknown>>()
        .mockResolvedValue({
          matchedCount: 2,
          matchedRunIds: ['new-1', 'new-2'],
          decisionSummaries: [],
          roundFailureWorkflowRepos: [],
          decidedWorkflowRepos: [WORKFLOW_REPO],
        });
      globalsPass.impl = dispatchGlobals;

      postSucceeded = vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
      normalizeEvent = vi.fn<(...args: unknown[]) => unknown>().mockReturnValue({
        type: 'push',
        payload: {},
        targetBranch: 'main',
        provider: 'github',
      });
      providerBundle.normalizer.normalizeEvent =
        normalizeEvent as unknown as typeof providerBundle.normalizer.normalizeEvent;
      (providerBundle.normalizer as any).extractCredentials = vi.fn().mockReturnValue({
        token: 'inbound-token',
      });
      (providerBundle as any).checkStatusPoster = {
        provider: 'github',
        postGlobalEvalSucceededCheck: postSucceeded,
      };
      (providerBundle as any).changedFilesFetcher = {
        getChangedFiles: vi.fn().mockResolvedValue({ files: ['a.ts'], status: 'fetched' }),
      };

      deps.db = makeMockDb(ROUND_RUN) as any;
      deps.processingDeps = () => ({ orchestratorMode: 'platform' }) as any;
    });

    /**
     * Re-run the round, then settle the re-evaluation it detached.
     *
     * The request is answered as soon as the claim is taken: the round itself is
     * a dispatched agent job whose budget is minutes, and the relayed dashboard
     * call it answers has ten seconds. So an assertion about the PASS has to
     * wait for the detached work rather than for the call — and settling also
     * keeps a still-running re-evaluation from reaching the next test's mocks.
     */
    async function rerunRound(
      requestId: string,
      actor: string | null = null,
    ): Promise<{ newRunId: string }> {
      const result = await handleRerun('original-run-123', actor, null, deps, requestId);
      await settlePendingRoundReevaluations();
      return result;
    }

    it('answers the request before the round it detached has finished', async () => {
      // The defect this guards: the whole re-evaluation used to run inside the
      // reply, so a round that takes longer than the relay's ten-second budget
      // — which every real round does — returned a gateway timeout to the
      // operator while completing unobserved.
      let releaseRound: () => void = () => {};
      const roundStarted = new Promise<void>((startResolve) => {
        dispatchGlobals.mockImplementation(async () => {
          startResolve();
          await new Promise<void>((r) => {
            releaseRound = r;
          });
          return {
            matchedCount: 1,
            matchedRunIds: ['new-1'],
            decisionSummaries: [],
            roundFailureWorkflowRepos: [],
            decidedWorkflowRepos: [WORKFLOW_REPO],
          };
        });
      });

      const result = await handleRerun('original-run-123', null, null, deps, 'req-round-async');

      // Answered while the round is still in flight — the point of the fix.
      expect(result.newRunId).toBe('original-run-123');
      await roundStarted;
      expect(postSucceeded).not.toHaveBeenCalled();

      // And the detached work still completes and posts its check.
      releaseRound();
      await settlePendingRoundReevaluations();
      expect(postSucceeded).toHaveBeenCalledTimes(1);
    });

    it('bypasses the cross-repository refusal and re-drives the scoped pass', async () => {
      await rerunRound('req-round-1', 'user@test.com');

      expect(dispatchGlobals).toHaveBeenCalledTimes(1);
      const passArgs = dispatchGlobals.mock.calls[0][0];
      // Scoped to the round's own workflow repository: every other repo's globals
      // already reached their verdict on the original delivery.
      expect(passArgs.onlyWorkflowRepo).toBe(WORKFLOW_REPO);
      expect(passArgs.repoIdentifier).toBe(SOURCE_REPO);
      expect(passArgs.ref).toBe('abc123def');
      // No workflow is resolved out of the source repo's lock file — that is the
      // whole reason the refusal does not apply here.
      expect(providerBundle.lockFileFetcher!.fetchLockFile).not.toHaveBeenCalled();
    });

    it('scopes the delivery lookup to the round’s own org', async () => {
      const { db: scopedDb, mocks } = createMockDb({ selectFirstRow: ROUND_RUN });
      deps.db = scopedDb as any;

      await rerunRound('req-round-org-scope');

      // `event_log`'s uniqueness is composite — (org_id, delivery_id) — and for
      // a generic source the delivery id is entirely sender-supplied, so a
      // lookup by delivery id alone can read another tenant's row.
      expect(mocks.selectWhere.mock.calls).toContainEqual(['org_id', '=', 'org-1']);
      expect(mocks.selectWhere.mock.calls).toContainEqual(['delivery_id', '=', 'del-round-1']);
    });

    it('does not read an event_log row that belongs to another org', async () => {
      // Same `delivery_id`, different tenant: a second org's generic source can
      // choose `X-Delivery-Id` freely, so this row is reachable by delivery id
      // alone. Scoping by org is what keeps it out of this round's re-evaluation.
      deps.db = makeMockDb({ ...ROUND_RUN, org_id: 'org-2' }) as any;

      await expect(
        handleRerun('original-run-123', null, null, deps, 'req-round-other-org'),
      ).rejects.toThrow(/no event log entry for delivery/);
      expect(dispatchGlobals).not.toHaveBeenCalled();
    });

    it('refuses a round that recorded no workflow repository', async () => {
      // The pass skips every registration authored in the source repository
      // BEFORE it applies the scope, so scoping on the source repo matches
      // nothing, evaluates nothing, and reports no failure — which the success
      // check would then read as a clean re-evaluation. There is no reading of a
      // NULL column that re-evaluates anything, so refusing is the honest answer.
      deps.db = makeMockDb({ ...ROUND_RUN, workflow_repo_identifier: null }) as any;

      await expect(
        handleRerun('original-run-123', 'user@test.com', null, deps, 'req-round-null'),
      ).rejects.toThrow(/records no workflow repository/);
      expect(dispatchGlobals).not.toHaveBeenCalled();
    });

    /**
     * A cross-provider global resolves its lock file through ANOTHER source's
     * bundle, so the round's `provider_context` holds that source's dispatch
     * credentials while its `routing_key` names the inbound one. Pairing the two
     * hands one source's credentials to the other source's API client.
     */
    describe('a round whose dispatch source is not the inbound source', () => {
      const DISPATCH_KEY = 'github:99';
      let dispatchBundle: ReturnType<typeof createMockProviderBundle>;

      beforeEach(() => {
        dispatchBundle = createMockProviderBundle();
        (deps.providerRegistry as any).getByRoutingKey = vi
          .fn()
          .mockImplementation((key: string) =>
            key === DISPATCH_KEY ? dispatchBundle : providerBundle,
          );
        deps.db = makeMockDb({ ...ROUND_RUN, dispatch_routing_key: DISPATCH_KEY }) as any;
      });

      it('hands the pass the bundle the stored credentials belong to', async () => {
        await rerunRound('req-round-dispatch');

        const passArgs = dispatchGlobals.mock.calls[0][0];
        // The dispatch pair: the fallback source's bundle with the credentials
        // recorded from that same source.
        expect(passArgs.dispatchBundle).toBe(dispatchBundle);
        expect(passArgs.dispatchCredentials).toEqual({ installationId: 42 });
        expect(passArgs.dispatchRoutingKey).toBe(DISPATCH_KEY);
        // The inbound pair, unchanged: the check lands on the repository that
        // emitted the event, through its own source.
        expect(passArgs.bundle).toBe(providerBundle);
        expect(passArgs.credentials).toEqual({ token: 'inbound-token' });
      });

      it("fetches changed files with the inbound source's own credentials", async () => {
        await rerunRound('req-round-changed-files');

        const fetcher = (providerBundle as any).changedFilesFetcher.getChangedFiles;
        expect(fetcher).toHaveBeenCalledTimes(1);
        // The fetch reads the INBOUND repository through the inbound bundle, so
        // it must carry the inbound credentials — never the stored dispatch ones.
        expect(fetcher.mock.calls[0][3]).toEqual({ token: 'inbound-token' });
      });

      it('refuses when the recorded dispatch source is no longer registered', async () => {
        (deps.providerRegistry as any).getByRoutingKey = vi
          .fn()
          .mockImplementation((key: string) => (key === DISPATCH_KEY ? undefined : providerBundle));

        await expect(
          handleRerun('original-run-123', null, null, deps, 'req-round-dispatch-gone'),
        ).rejects.toThrow(/dispatch source github:99 is no longer registered/);
        expect(dispatchGlobals).not.toHaveBeenCalled();
      });
    });

    it('posts the success check on the original commit through the inbound repo', async () => {
      await rerunRound('req-round-2', 'user@test.com');

      expect(postSucceeded).toHaveBeenCalledTimes(1);
      const [repo, sha, summary, credentials] = postSucceeded.mock.calls[0];
      expect(repo).toBe(SOURCE_REPO);
      expect(sha).toBe('abc123def');
      // Names the workflow repo it re-evaluated: one shared check name serves
      // every round on the commit, so the summary is what tells them apart.
      expect(summary).toContain(WORKFLOW_REPO);
      // The INBOUND repo's credentials, never the dispatch context (which for a
      // cross-provider global belongs to another source).
      expect(credentials).toEqual({ token: 'inbound-token' });
    });

    it('posts no success check when the scoped round failed again', async () => {
      dispatchGlobals.mockResolvedValue({
        matchedCount: 0,
        matchedRunIds: [],
        decisionSummaries: [],
        roundFailureWorkflowRepos: [WORKFLOW_REPO],
        decidedWorkflowRepos: [],
      });

      await rerunRound('req-round-3', 'user@test.com');

      // The pass's own failure surfacing already posted the fresh failure check.
      expect(postSucceeded).not.toHaveBeenCalled();
    });

    it('posts no success check when the pass reported no verdict for the round', async () => {
      // The false-assurance case: a coordinator with no pending-eval tracker (or
      // no registration index) suppresses every candidate, deliberately raises
      // no round failure, and evaluates nothing. Reading that silence as a clean
      // re-evaluation would flip the gating check to success and unblock a merge
      // bot on work that provably did not run.
      dispatchGlobals.mockResolvedValue({
        matchedCount: 0,
        matchedRunIds: [],
        decisionSummaries: [],
        roundFailureWorkflowRepos: [],
        decidedWorkflowRepos: [],
      });

      await rerunRound('req-round-undecided', 'user@test.com');

      expect(dispatchGlobals).toHaveBeenCalledTimes(1);
      expect(postSucceeded).not.toHaveBeenCalled();
    });

    it('posts the success check for a repo the pass decided but admitted nothing for', async () => {
      // The other half of the same rule: "decided" is the positive signal, not
      // "dispatched something". A round whose verdicts all came back `run: false`
      // evaluated the repository fully and cleanly.
      dispatchGlobals.mockResolvedValue({
        matchedCount: 0,
        matchedRunIds: [],
        decisionSummaries: [],
        roundFailureWorkflowRepos: [],
        decidedWorkflowRepos: [WORKFLOW_REPO],
      });

      await rerunRound('req-round-decided-empty', 'user@test.com');

      expect(postSucceeded).toHaveBeenCalledTimes(1);
    });

    it('posts no success check when the trust policy skipped the pass', async () => {
      // A pass the policy did not admit evaluated nothing, so it reports no
      // round failure either. Reading that as a clean re-evaluation would post
      // success for work that never ran.
      dispatchGlobals.mockImplementation(async (args) => {
        const decision = args.securityDecision as { action: string };
        if (decision.action !== 'pass') {
          return {
            matchedCount: 0,
            matchedRunIds: [],
            decisionSummaries: [],
            roundFailureWorkflowRepos: [],
            decidedWorkflowRepos: [],
          };
        }
        throw new Error('the policy-skipped case must not reach the evaluating branch');
      });
      // A fork PR the org policy holds. `hasForkModel` is what brings the
      // policy into play at all, and the fail-closed default holds the event.
      normalizeEvent.mockReturnValue({
        type: 'pr',
        payload: {},
        targetBranch: 'main',
        provider: 'github',
        isForkPR: true,
      });
      (providerBundle as any).hasForkModel = true;
      deps.db = makeMockDb({ ...ROUND_RUN, event: 'pull_request', action: 'opened' }) as any;

      await rerunRound('req-round-policy');

      expect(dispatchGlobals).toHaveBeenCalledTimes(1);
      expect(postSucceeded).not.toHaveBeenCalled();
    });

    it('fails with an actionable error when the payload was not stored', async () => {
      logStorage = createMockLogStorage(null);
      deps.logStorage = logStorage as any;

      await expect(
        handleRerun('original-run-123', 'user@test.com', null, deps, 'req-round-4'),
      ).rejects.toThrow(/payload was not stored/);
      expect(dispatchGlobals).not.toHaveBeenCalled();
    });

    it('rejects an event it can no longer normalize on both hops of a re-send', async () => {
      // `normalizeEvent` is read-only validation, so it must run BEFORE the
      // requestId claim: claimed first, the second hop of a relay failover
      // re-send short-circuits on the claim and answers HTTP 200 with the round's
      // own run id — telling the operator the re-run succeeded when nothing ran.
      const requestId = 'req-round-normalize-first';
      normalizeEvent.mockReturnValue(null);

      await expect(handleRerun('original-run-123', null, null, deps, requestId)).rejects.toThrow(
        /no longer one this orchestrator normalizes/,
      );
      await expect(handleRerun('original-run-123', null, null, deps, requestId)).rejects.toThrow(
        /no longer one this orchestrator normalizes/,
      );
      expect(dispatchGlobals).not.toHaveBeenCalled();
    });

    it('throws the same reconstruction failure on both hops of a failover re-send', async () => {
      // The read-only reconstruction runs BEFORE the requestId claim, so a hop
      // that could not rebuild the delivery does not leave the claim behind for
      // the re-send to report as a success.
      const requestId = 'req-round-validate-first';
      deps.db = makeMockDb({ ...ROUND_RUN, delivery_id: null }) as any;

      await expect(handleRerun('original-run-123', null, null, deps, requestId)).rejects.toThrow(
        /records no delivery id/,
      );
      await expect(handleRerun('original-run-123', null, null, deps, requestId)).rejects.toThrow(
        /records no delivery id/,
      );
      expect(dispatchGlobals).not.toHaveBeenCalled();
    });

    it('re-evaluates once across a failover re-send of the same requestId', async () => {
      const requestId = 'req-round-dedupe';
      await rerunRound(requestId);
      await rerunRound(requestId);

      expect(dispatchGlobals).toHaveBeenCalledTimes(1);
    });

    it('returns the round run id, so a re-send answers identically', async () => {
      const requestId = 'req-round-stable';
      const first = await rerunRound(requestId);
      const second = await rerunRound(requestId);

      expect(first.newRunId).toBe('original-run-123');
      expect(second.newRunId).toBe(first.newRunId);
    });
  });
});
