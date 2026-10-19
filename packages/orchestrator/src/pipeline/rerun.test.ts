import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { handleRerun, settlePendingRoundReevaluations, type RerunDeps } from './rerun.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';
import { staticJob } from '../__test-helpers__/lock-fixtures.js';

// The mock DB cannot enforce `INSERT … ON CONFLICT` dedup (real Postgres
// covers it in `request-idempotency.test.ts`), so an in-memory claim exercises
// `handleRerun`'s wiring: a `claimed: false` re-send short-circuits before dispatch.
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

// The organization-wide pass has its own suite
// (`process-webhook-globals-eval-round.test.ts`); stubbed here so the
// round-rerun tests observe the scope, repository and commit the rerun asks
// for. Everything else in `process-webhook.js` stays real.
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

// Stubs the shared pipeline a cross-repository global re-run dispatches
// through, so tests observe the recorded commits, lineage and job list it is
// handed. Unset, every call reaches the real implementation.
const pipeline = vi.hoisted(() => ({
  spy: null as null | ((ctx: Record<string, unknown>) => Promise<unknown>),
}));

vi.mock('./dispatch-matched-workflow.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./dispatch-matched-workflow.js')>();
  return {
    ...actual,
    dispatchMatchedWorkflow: (ctx: Parameters<typeof actual.dispatchMatchedWorkflow>[0]) =>
      pipeline.spy
        ? pipeline.spy(ctx as unknown as Record<string, unknown>)
        : actual.dispatchMatchedWorkflow(ctx),
  };
});

// Stubs the internal-event pipeline a payload-less re-run dispatches through
// (it has its own suite), so tests observe the event, context and overrides.
const internalPipeline = vi.hoisted(() => ({
  spy: null as null | ((...args: unknown[]) => Promise<unknown>),
}));

vi.mock('./internal-event-pipeline.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./internal-event-pipeline.js')>();
  return {
    ...actual,
    dispatchInternalEventViaPipeline: (
      ...args: Parameters<typeof actual.dispatchInternalEventViaPipeline>
    ) =>
      internalPipeline.spy
        ? internalPipeline.spy(...args)
        : actual.dispatchInternalEventViaPipeline(...args),
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
  customer_id: 'org-7',
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
  original_run_id: null,
  trigger_event: 'push',
  subject_trigger_event: null,
  // The delivery's `event_log` columns: the mock DB serves this row to every
  // select whose predicates it satisfies, the delivery lookup included.
  org_id: 'org-7',
  event: 'push',
  action: null,
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
        staticJob({
          name: 'test',
          runsOn: [{ kind: 'exact', value: 'default' }],
          steps: [{ name: 'run tests', run: 'npm test' }],
        }),
      ],
    },
  ],
};

const PUSH_EVENT = {
  type: 'push',
  payload: {},
  targetBranch: 'main',
  provider: 'github',
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
  let getAllByOrgAndRepo: Mock;
  let dispatched: Mock<(ctx: Record<string, unknown>) => Promise<unknown>>;

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
      processingDeps: () => ({ registrationIndex: { getAllByOrgAndRepo } }) as any,
    };
    providerBundle.normalizer.normalizeEvent.mockReturnValue(PUSH_EVENT);
    getAllByOrgAndRepo = vi.fn(() => []);
    dispatched = vi.fn<(ctx: Record<string, unknown>) => Promise<unknown>>().mockResolvedValue({});
    pipeline.spy = dispatched;
  });

  afterEach(() => {
    pipeline.spy = null;
  });

  /** The context the re-run handed the shared pipeline. */
  function dispatchedCtx(): Record<string, any> {
    expect(dispatched).toHaveBeenCalledTimes(1);
    return dispatched.mock.calls[0][0] as Record<string, any>;
  }

  it("re-runs through the shared pipeline with the original run's org, repository, commit and lineage", async () => {
    const result = await handleRerun('original-run-123', 'user@test.com', null, deps, 'req-test');

    expect(logStorage.read).toHaveBeenCalledWith(
      'executions/original-run-123/webhook-payload.json',
    );
    expect(providerBundle.lockFileFetcher!.fetchLockFile).toHaveBeenCalledWith(
      'owner/repo',
      'abc123def',
      expect.objectContaining({ installationId: 42 }),
    );
    // fails-when: the re-run hand-builds its own job config instead of going
    // through the pipeline, which drops needs ordering, contexts, containers
    // and the cache identity every artifact request is resolved against
    const ctx = dispatchedCtx();
    expect(ctx).toMatchObject({
      runId: result.newRunId,
      resolvedOrgId: 'org-7',
      repoIdentifier: 'owner/repo',
      workflowRepoIdentifier: 'owner/repo',
      ref: 'abc123def',
      triggerEventOverride: 'rerun',
      triggeredBy: 'user@test.com',
      rerunLineage: { parentRunId: 'original-run-123', originalRunId: 'original-run-123' },
      subjectTriggerEvent: 'push',
      securityDecision: { action: 'pass' },
      decision: { workflowName: 'ci', matched: true },
      info: { routingKey: 'github:42', event: 'push', deliveryId: `rerun:${result.newRunId}` },
    });
    // A push is trusted, so its jobs write the shared cache scope.
    expect(ctx.trustResolution?.tier).toBe('trusted');
    expect(ctx.workflow.jobs.map((j: { name: string }) => j.name)).toEqual(['test']);
    expect(ctx.global).toBeUndefined();
  });

  it('is idempotent on requestId: a failover re-send returns the same run without a second dispatch', async () => {
    const requestId = 'req-dedupe-1';
    const first = await handleRerun('original-run-123', 'user@test.com', null, deps, requestId);
    const second = await handleRerun('original-run-123', 'user@test.com', null, deps, requestId);

    expect(second.newRunId).toBe(first.newRunId);
    expect(dispatched).toHaveBeenCalledTimes(1);
  });

  it('re-runs only the declared static jobs, without evaluating the workflow filter again', async () => {
    providerBundle.lockFileFetcher!.fetchLockFile.mockResolvedValue({
      ...LOCK_FILE,
      workflows: [
        {
          ...LOCK_FILE.workflows[0],
          hasFilter: true,
          jobs: [
            ...LOCK_FILE.workflows[0].jobs,
            { _type: 'dynamic', name: 'gen', source: '.kici/workflows/ci.ts' },
          ],
        },
      ],
    });

    await handleRerun('original-run-123', null, null, deps, 'req-test');

    const ctx = dispatchedCtx();
    expect(ctx.workflow.jobs.map((j: { name: string }) => j.name)).toEqual(['test']);
    expect(ctx.workflow.hasFilter).toBeUndefined();
    expect(ctx.fullLockFile.workflows).toEqual([ctx.workflow]);
  });

  /** A fork pull request run, in an org whose stored trust policy is `forkPolicy`. */
  function forkPrRun(forkPolicy: 'hold' | 'ignore' | 'allow'): void {
    (providerBundle as any).hasForkModel = true;
    deps.processingDeps = () =>
      ({
        registrationIndex: { getAllByOrgAndRepo },
        trustPolicyStore: { get: async () => ({ forkPolicy, approvalExpirySeconds: 3600 }) },
      }) as any;
    providerBundle.normalizer.normalizeEvent.mockReturnValue({
      type: 'pull_request',
      action: 'opened',
      payload: {},
      targetBranch: 'main',
      baseBranch: 'main',
      sourceBranch: 'patch-1',
      headRepo: 'attacker/repo',
      isForkPR: true,
      senderUsername: 'mallory',
      provider: 'github',
    });
    deps.db = makeMockDb({
      ...TERMINAL_RUN,
      trigger_event: 'pull_request:opened',
      event: 'pull_request',
      action: 'opened',
    }) as any;
  }

  it("reads an untrusted fork pull request's lock file from its base branch, as the run did", async () => {
    forkPrRun('hold');

    await handleRerun('original-run-123', null, null, deps, 'req-fork');

    // fails-when: the re-run reads the fork's own lock file at its head commit
    expect(providerBundle.lockFileFetcher!.fetchLockFile).toHaveBeenCalledWith(
      'owner/repo',
      'main',
      expect.anything(),
    );
    const ctx = dispatchedCtx();
    expect(ctx.lockFileSource).toBe('base');
    expect(ctx.trustResolution?.tier).not.toBe('trusted');
    // Re-running is not approving: the org holds fork pull requests, so the
    // re-run is held again, as its delivery was.
    // fails-when: the re-run passes the trust-policy gate unconditionally
    expect(ctx.securityDecision.action).toBe('hold');
    // The commit under test is still the head the run built.
    expect(ctx.ref).toBe('abc123def');
    expect(ctx.subjectTriggerEvent).toBe('pull_request:opened');
  });

  it('refuses a fork pull request re-run the trust policy now ignores, before claiming a run id', async () => {
    forkPrRun('ignore');

    // fails-when: the re-run claims a run id the ignored dispatch never creates
    await expect(handleRerun('original-run-123', null, null, deps, 'req-ignored')).rejects.toThrow(
      /the organization trust policy ignores the event it ran for/,
    );
    expect(dispatched).not.toHaveBeenCalled();
    // breaks-if-wrong: the same request id stays unclaimed, so a later re-run can use it
    forkPrRun('allow');
    await handleRerun('original-run-123', null, null, deps, 'req-ignored');
    expect(dispatched).toHaveBeenCalledTimes(1);
  });

  it('refuses a webhook run whose delivery is no longer in the event log', async () => {
    deps.db = makeMockDb({ ...TERMINAL_RUN, org_id: 'another-org' }) as any;

    await expect(handleRerun('original-run-123', null, null, deps, 'req-test')).rejects.toThrow(
      /Cannot re-run run original-run-123: the event it ran for is no longer stored/,
    );
    expect(dispatched).not.toHaveBeenCalled();
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

  describe('a run the orchestrator started', () => {
    // The pipeline stores every run's payload, so these runs have one too: the
    // harness default serves PAYLOAD. Their delivery is not in the event log.
    let internalDispatched: Mock<(...args: unknown[]) => Promise<unknown>>;

    beforeEach(() => {
      internalDispatched = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({});
      internalPipeline.spy = internalDispatched;
    });

    afterEach(() => {
      internalPipeline.spy = null;
    });

    /** The (lock file, context, overrides) the re-run handed the internal-event pipeline. */
    function internalCall(): { lockFile: any; ctx: any; overrides: any } {
      expect(internalDispatched).toHaveBeenCalledTimes(1);
      const [, lockFile, ctx, , overrides] = internalDispatched.mock.calls[0];
      return { lockFile, ctx, overrides };
    }

    it("fires a schedule again at the recorded commit, on the registration's default branch", async () => {
      deps.db = makeMockDb({ ...TERMINAL_RUN, trigger_event: 'schedule' }) as any;
      getAllByOrgAndRepo.mockReturnValue([{ workflowName: 'ci', defaultBranch: 'trunk' }]);

      // fails-when: the stored payload sends a cron run down the webhook path,
      // which finds no event log row and refuses
      const result = await handleRerun('original-run-123', null, null, deps, 'req-cron');

      expect(getAllByOrgAndRepo).toHaveBeenCalledWith('org-7', 'owner/repo');
      const { lockFile, ctx, overrides } = internalCall();
      expect(ctx).toMatchObject({
        event: { eventName: '__schedule_fire', payload: { commitSha: 'abc123def' } },
        cronCommitSha: 'abc123def',
        registrationDefaultBranch: 'trunk',
        routingKey: 'github:42',
        repoIdentifier: 'owner/repo',
      });
      expect(overrides).toMatchObject({
        runId: result.newRunId,
        triggerEvent: 'rerun',
        rerunLineage: { parentRunId: 'original-run-123' },
        subjectTriggerEvent: 'schedule',
      });
      expect(lockFile.workflows.map((w: { name: string }) => w.name)).toEqual(['ci']);
      expect(dispatched).not.toHaveBeenCalled();
    });

    it('re-runs a schedule fired by hand the same way', async () => {
      deps.db = makeMockDb({ ...TERMINAL_RUN, trigger_event: 'manual_schedule' }) as any;

      await handleRerun('original-run-123', null, null, deps, 'req-manual');

      expect(internalCall().ctx.event.eventName).toBe('__schedule_fire');
    });

    /**
     * A per-table fake: the shared mock DB serves one row to every select, so it
     * cannot give the emitting run another organization than the re-run.
     */
    function tablesDb(rows: {
      runs: Record<string, Record<string, unknown>>;
      event_log?: Record<string, unknown>;
      kici_events?: Record<string, unknown>;
    }) {
      return {
        selectFrom: (table: string) => {
          let runId: unknown;
          const chain: any = {
            select: () => chain,
            selectAll: () => chain,
            where: (col: string, _op: string, value: unknown) => {
              if (col === 'run_id') runId = value;
              return chain;
            },
            executeTakeFirst: async () =>
              table === 'execution_runs'
                ? rows.runs[String(runId)]
                : (rows as Record<string, unknown>)[table],
          };
          return chain;
        },
      };
    }

    it("refuses another organization's stored event that carries this run's delivery id", async () => {
      const eventId = '0f8fad5b-d9cb-469f-a165-70867728950e';
      const run = { ...TERMINAL_RUN, trigger_event: 'deploy-done', delivery_id: eventId };
      deps.db = tablesDb({
        runs: {
          'original-run-123': run,
          'run-of-org-9': { customer_id: 'org-9' },
        },
        kici_events: {
          id: eventId,
          event_name: 'deploy-done',
          payload: '{}',
          source_run_id: 'run-of-org-9',
          source_routing_key: null,
        },
      }) as any;

      // fails-when: the event is read by id alone, so this org re-runs org-9's event
      await expect(
        handleRerun('original-run-123', null, null, deps, 'req-foreign'),
      ).rejects.toThrow(/the event it ran for is no longer stored/);
      expect(internalDispatched).not.toHaveBeenCalled();
    });

    it('re-runs a summoned run from its stored payload, inheriting its summoner', async () => {
      deps.db = makeMockDb({
        ...TERMINAL_RUN,
        trigger_event: 'build-docs',
        delivery_id: 'invoke-5d2f',
        summoned_by_run_id: 'summoner-run',
        chain_depth: 1,
        org_id: 'another-org',
      }) as any;

      // breaks-if-wrong: a summoned run must still re-run, as it did before
      await handleRerun('original-run-123', null, null, deps, 'req-summoned');

      const { ctx } = internalCall();
      expect(ctx.event).toEqual({ id: 'invoke-5d2f', eventName: 'build-docs', payload: PAYLOAD });
      expect(ctx.summonedByRunId).toBe('summoner-run');
      expect(ctx.chainDepth).toBe(1);
    });

    it('refuses a summoned run whose stored payload is gone', async () => {
      logStorage.read.mockResolvedValue({ data: null, cursor: 0, complete: true });
      deps.db = makeMockDb({
        ...TERMINAL_RUN,
        trigger_event: 'build-docs',
        delivery_id: 'invoke-5d2f',
        summoned_by_run_id: 'summoner-run',
        org_id: 'another-org',
      }) as any;

      // fails-when: the summoned run re-runs with an empty event payload
      await expect(
        handleRerun('original-run-123', null, null, deps, 'req-sum-gone'),
      ).rejects.toThrow(/the event it ran for is no longer stored/);
      expect(internalDispatched).not.toHaveBeenCalled();
    });

    it('refuses an internal-event run whose event is no longer stored', async () => {
      deps.db = makeMockDb({
        ...TERMINAL_RUN,
        trigger_event: 'deploy-done',
        org_id: 'another-org',
      }) as any;

      // fails-when: the run is re-dispatched with no event at all
      await expect(handleRerun('original-run-123', null, null, deps, 'req-gone')).rejects.toThrow(
        /the event it ran for is no longer stored/,
      );
      expect(internalDispatched).not.toHaveBeenCalled();
    });

    it('re-runs an internal-event run with its stored event', async () => {
      const eventId = '0f8fad5b-d9cb-469f-a165-70867728950e';
      deps.db = makeMockDb({
        ...TERMINAL_RUN,
        trigger_event: 'deploy-done',
        org_id: 'another-org',
        chain_depth: 2,
        delivery_id: eventId,
        id: eventId,
        // Emitted by a run of this organization (the mock serves this same row).
        source_run_id: 'original-run-123',
        event_name: 'deploy-done',
        payload: JSON.stringify({ env: 'prod' }),
      }) as any;

      // breaks-if-wrong: a run whose event is still stored must re-run
      await handleRerun('original-run-123', null, null, deps, 'req-event');

      // The stored event id, so the re-run inherits the trust of the run that emitted it.
      expect(internalCall().ctx.event).toEqual({
        id: eventId,
        eventName: 'deploy-done',
        payload: { env: 'prod' },
      });
      // The re-run counts toward the invoke-gate bound its first run did.
      expect(internalCall().ctx.chainDepth).toBe(2);
    });
  });

  it('fails with error if lock file not found at original SHA', async () => {
    providerBundle.lockFileFetcher!.fetchLockFile.mockResolvedValue(null);

    await expect(handleRerun('original-run-123', null, null, deps, 'req-test')).rejects.toThrow(
      'Lock file not found at original SHA',
    );
  });

  describe('an organization-wide run that executed against another repository', () => {
    /**
     * `repo_identifier` is the SOURCE repository the run acted on; the
     * workflow lives in `workflow_repo_identifier` at `workflow_sha`.
     *
     * The row also carries the `event_log` columns (`org_id`, `event`,
     * `action`): the mock DB serves it to every select whose predicates it
     * satisfies, the delivery lookup included.
     */
    const SOURCE_REPO = 'org/app';
    const WORKFLOW_REPO = 'org/ci';
    const WORKFLOW_ROUTING_KEY = 'github:ci';
    const GLOBAL_RUN = {
      ...TERMINAL_RUN,
      workflow_name: 'org-ci',
      repo_identifier: SOURCE_REPO,
      sha: 's1',
      workflow_repo_identifier: WORKFLOW_REPO,
      workflow_sha: 'a1',
      workflow_branch: 'main',
      customer_id: 'org-1',
      org_id: 'org-1',
      original_run_id: null,
      event: 'push',
      action: null,
    };
    const REG_PROVIDER_CONTEXT = { installationId: 7 };

    /** A global workflow's lock entry: one static job and one generator. */
    function globalEntry(jobName: string) {
      return {
        name: 'org-ci',
        source: { file: '.kici/workflows/org-ci.ts' },
        hasFilter: true,
        triggers: [{ _type: 'push', repos: ['org/*'] }],
        jobs: [
          staticJob({
            name: jobName,
            runsOn: [{ kind: 'exact', value: 'default' }],
            steps: [{ name: 'run', run: 'true' }],
          }),
          { _type: 'dynamic', name: 'gen', source: '.kici/workflows/org-ci.ts' },
        ],
      };
    }

    let workflowBundle: ReturnType<typeof createMockProviderBundle> & {
      cloneTokenProvider: { createCloneToken: Mock };
    };
    let registration: Record<string, unknown>;
    let getAllByOrgAndRepo: Mock;
    let dispatched: Mock<(ctx: Record<string, unknown>) => Promise<unknown>>;

    beforeEach(() => {
      workflowBundle = {
        ...createMockProviderBundle(),
        cloneTokenProvider: { createCloneToken: vi.fn().mockResolvedValue('wf-token') },
      };
      workflowBundle.lockFileFetcher.fetchLockFile.mockResolvedValue({
        version: 2,
        workflows: [globalEntry('lint-at-a1')],
      });
      (deps.providerRegistry as any).getByRoutingKey = vi.fn((key: string) =>
        key === WORKFLOW_ROUTING_KEY ? workflowBundle : providerBundle,
      );
      providerBundle.normalizer.normalizeEvent.mockReturnValue({
        type: 'push',
        payload: PAYLOAD,
        targetBranch: 'main',
        provider: 'github',
      });
      // The workflow repository has moved on to `b2` since the run.
      registration = {
        id: 'reg-1',
        repoIdentifier: WORKFLOW_REPO,
        workflowName: 'org-ci',
        lockEntry: globalEntry('lint-at-b2'),
        triggerTypes: ['push'],
        routingKey: WORKFLOW_ROUTING_KEY,
        providerContext: REG_PROVIDER_CONTEXT,
        disabled: false,
        isGlobal: true,
        customerId: 'org-1',
        commitSha: 'b2',
        defaultBranch: 'main',
        sourceFile: '.kici/workflows/org-ci.ts',
      };
      getAllByOrgAndRepo = vi.fn(() => [registration]);
      deps.processingDeps = () => ({ registrationIndex: { getAllByOrgAndRepo } }) as any;
      dispatched = vi
        .fn<(ctx: Record<string, unknown>) => Promise<unknown>>()
        .mockResolvedValue({});
      pipeline.spy = dispatched;
      deps.db = makeMockDb(GLOBAL_RUN) as any;
    });

    afterEach(() => {
      pipeline.spy = null;
    });

    it('re-runs a cross-repo global run against its recorded workflow commit', async () => {
      // fails-when: re-run is refused, or loads the lock at the registration's current commit
      const result = await handleRerun('original-run-123', 'user@test.com', null, deps, 'req-g1');

      expect(workflowBundle.lockFileFetcher.fetchLockFile).toHaveBeenCalledWith(
        WORKFLOW_REPO,
        'a1',
        REG_PROVIDER_CONTEXT,
      );
      // The source repository's lock file is never read: its same-named
      // workflow is not the one this run executed.
      expect(providerBundle.lockFileFetcher.fetchLockFile).not.toHaveBeenCalled();
      expect(getAllByOrgAndRepo).toHaveBeenCalledWith('org-1', WORKFLOW_REPO);

      expect(dispatched).toHaveBeenCalledTimes(1);
      const ctx = dispatched.mock.calls[0][0] as any;
      expect(ctx.runId).toBe(result.newRunId);
      expect(ctx.ref).toBe('s1');
      expect(ctx.repoIdentifier).toBe(SOURCE_REPO);
      expect(ctx.workflowRepoIdentifier).toBe(WORKFLOW_REPO);
      expect(ctx.global.workflowSha).toBe('a1');
      expect(ctx.global.workflowBranch).toBe('main');
      expect(ctx.global.workflowRoutingKey).toBe(WORKFLOW_ROUTING_KEY);
      expect(ctx.global.workflowBundle).toBe(workflowBundle);
      expect(ctx.global.workflowCredentials).toEqual({
        ...REG_PROVIDER_CONTEXT,
        token: 'wf-token',
      });
      // The recorded version's static job, not the current one's; the
      // generator and the already-decided filter are not replayed.
      expect(ctx.workflow.jobs.map((j: { name: string }) => j.name)).toEqual(['lint-at-a1']);
      expect(ctx.workflow.hasFilter).toBeUndefined();
      expect(ctx.rerunLineage).toEqual({
        parentRunId: 'original-run-123',
        originalRunId: 'original-run-123',
      });
      expect(ctx.triggerEventOverride).toBe('rerun');
      expect(ctx.triggeredBy).toBe('user@test.com');
      expect(ctx.info.deliveryId).toBe(`rerun:${result.newRunId}`);
      expect(ctx.info.event).toBe('push');
      expect(ctx.event.sourceRepo).toBe(SOURCE_REPO);
      expect(ctx.securityDecision).toEqual({ action: 'pass' });
      // The pipeline stores the payload under the new run, once.
      // fails-when: the re-run also appends it, leaving two concatenated copies
      // no reader can parse, so a re-run of the re-run loses its payload
      expect(ctx.payload).toEqual(PAYLOAD);
      expect(logStorage.append).not.toHaveBeenCalled();
      expect(eventRouter.emit).toHaveBeenCalledWith(
        expect.objectContaining({ eventName: 'workflow.rerun' }),
      );
    });

    it('uses the registration lock entry without fetching when it is at the recorded commit', async () => {
      // fails-when: a registration already at the recorded commit is fetched again
      registration.commitSha = 'a1';

      await handleRerun('original-run-123', null, null, deps, 'req-g2');

      expect(workflowBundle.lockFileFetcher.fetchLockFile).not.toHaveBeenCalled();
      const ctx = dispatched.mock.calls[0][0] as any;
      expect(ctx.workflow.jobs.map((j: { name: string }) => j.name)).toEqual(['lint-at-b2']);
    });

    it('probes the dependency cache with the key of the lock file at the recorded commit', async () => {
      // fails-when: the re-run keys the dependency cache with the registration's current lock file,
      //   restoring dependencies built for a commit the re-run does not check out
      registration.lockfileHash = 'lock-at-b2';
      registration.siblingsDigest = 'siblings-at-b2';
      workflowBundle.lockFileFetcher.fetchLockFile.mockResolvedValue({
        version: 2,
        lockfileHash: 'lock-at-a1',
        siblingsDigest: 'siblings-at-a1',
        workflows: [globalEntry('lint-at-a1')],
      });

      await handleRerun('original-run-123', null, null, deps, 'req-g20');

      const ctx = dispatched.mock.calls[0][0] as any;
      expect(ctx.fullLockFile.lockfileHash).toBe('lock-at-a1');
      expect(ctx.fullLockFile.siblingsDigest).toBe('siblings-at-a1');
    });

    it('probes with no key when the lock file at the recorded commit records none', async () => {
      // breaks-if-wrong: a moved-on registration's key must not stand in for a commit that had none
      registration.lockfileHash = 'lock-at-b2';
      registration.siblingsDigest = 'siblings-at-b2';

      await handleRerun('original-run-123', null, null, deps, 'req-g21');

      const ctx = dispatched.mock.calls[0][0] as any;
      expect(ctx.workflow.jobs.map((j: { name: string }) => j.name)).toEqual(['lint-at-a1']);
      expect(ctx.fullLockFile.lockfileHash).toBeUndefined();
      expect(ctx.fullLockFile.siblingsDigest).toBeUndefined();
    });

    it("uses the registration's key when it is at the recorded commit", async () => {
      // fails-when: a registration already at the recorded commit loses its key on re-run
      registration.commitSha = 'a1';
      registration.lockfileHash = 'lock-at-a1';
      registration.siblingsDigest = null;

      await handleRerun('original-run-123', null, null, deps, 'req-g22');

      expect(workflowBundle.lockFileFetcher.fetchLockFile).not.toHaveBeenCalled();
      const ctx = dispatched.mock.calls[0][0] as any;
      expect(ctx.fullLockFile.lockfileHash).toBe('lock-at-a1');
      expect(ctx.fullLockFile.siblingsDigest).toBeUndefined();
    });

    it('keeps the pull-request subject event of a re-run of a PR run', async () => {
      // fails-when: the re-run states no subject event, so its OIDC subject derives from `rerun`
      deps.db = makeMockDb({ ...GLOBAL_RUN, trigger_event: 'pull_request' }) as any;
      await handleRerun('original-run-123', null, null, deps, 'req-g10');
      expect((dispatched.mock.calls[0][0] as any).subjectTriggerEvent).toBe('pull_request');

      // A re-run of that re-run records `rerun` itself but inherits the subject.
      dispatched.mockClear();
      deps.db = makeMockDb({
        ...GLOBAL_RUN,
        trigger_event: 'rerun',
        subject_trigger_event: 'pull_request',
      }) as any;
      await handleRerun('original-run-123', null, null, deps, 'req-g11');
      expect((dispatched.mock.calls[0][0] as any).subjectTriggerEvent).toBe('pull_request');
    });

    it('keeps the lineage root of a re-run of a re-run', async () => {
      deps.db = makeMockDb({
        ...GLOBAL_RUN,
        run_id: 'rerun-2',
        original_run_id: 'root-run',
      }) as any;

      await handleRerun('rerun-2', null, null, deps, 'req-g3');

      const ctx = dispatched.mock.calls[0][0] as any;
      expect(ctx.rerunLineage).toEqual({ parentRunId: 'rerun-2', originalRunId: 'root-run' });
    });

    it('refuses to re-run a global run whose workflow registration was deleted, naming the repo', async () => {
      // breaks-if-wrong: must not fall back to any current lock
      getAllByOrgAndRepo.mockReturnValue([]);

      await expect(handleRerun('original-run-123', null, null, deps, 'req-g4')).rejects.toThrow(
        /workflow repository org\/ci no longer registers it/,
      );
      expect(workflowBundle.lockFileFetcher.fetchLockFile).not.toHaveBeenCalled();
      expect(providerBundle.lockFileFetcher.fetchLockFile).not.toHaveBeenCalled();
      expect(dispatched).not.toHaveBeenCalled();
      expect(eventRouter.emit).not.toHaveBeenCalled();
    });

    it('refuses a workflow that is disabled, saying so', async () => {
      // fails-when: the lookup cannot see disabled rows and the refusal says the workflow is gone
      registration.disabled = true;

      await expect(handleRerun('original-run-123', null, null, deps, 'req-g14')).rejects.toThrow(
        /it is disabled in workflow repository org\/ci/,
      );
      expect(dispatched).not.toHaveBeenCalled();
    });

    it('re-runs a global run with no recorded workflow_sha by refusing with a clear message', async () => {
      // fails-when: a run with no recorded workflow commit re-runs at the registration's commit
      deps.db = makeMockDb({ ...GLOBAL_RUN, workflow_sha: null }) as any;

      await expect(handleRerun('original-run-123', null, null, deps, 'req-g5')).rejects.toThrow(
        /no recorded workflow commit/,
      );
      expect(dispatched).not.toHaveBeenCalled();
    });

    it('refuses when the recorded commit has no lock file, instead of using the current one', async () => {
      // breaks-if-wrong: a force-pushed-away commit must not fall back to the registration's lock entry
      workflowBundle.lockFileFetcher.fetchLockFile.mockResolvedValue(null);

      await expect(handleRerun('original-run-123', null, null, deps, 'req-g6')).rejects.toThrow(
        /org\/ci has no lock file at a1/,
      );
      expect(dispatched).not.toHaveBeenCalled();
    });

    it('refuses a workflow that was not organization-wide at the recorded commit', async () => {
      // fails-when: global-ness is read from the current registration instead of the recorded entry
      const { triggers: _global, ...entry } = globalEntry('lint-at-a1');
      workflowBundle.lockFileFetcher.fetchLockFile.mockResolvedValue({
        version: 2,
        workflows: [{ ...entry, triggers: [{ _type: 'push' }] }],
      });

      await expect(handleRerun('original-run-123', null, null, deps, 'req-g7')).rejects.toThrow(
        /at a1 it is not an organization-wide workflow/,
      );
      expect(dispatched).not.toHaveBeenCalled();
    });

    it('judges global-ness from the recorded commit, not the current registration', async () => {
      // breaks-if-wrong: a workflow global at the recorded commit re-runs whatever its registration says now
      registration.isGlobal = false;

      await handleRerun('original-run-123', null, null, deps, 'req-g12');

      expect(dispatched).toHaveBeenCalledTimes(1);
    });

    it('presents no workflow branch when the run recorded none', async () => {
      // fails-when: the re-run guesses the registration's branch for a run that recorded none
      deps.db = makeMockDb({ ...GLOBAL_RUN, workflow_branch: null }) as any;

      await handleRerun('original-run-123', null, null, deps, 'req-g13');

      expect((dispatched.mock.calls[0][0] as any).global.workflowBranch).toBeNull();
    });

    it('refuses when the global workflow policy no longer admits the workflow repository', async () => {
      deps.processingDeps = () =>
        ({
          registrationIndex: { getAllByOrgAndRepo },
          globalWorkflowPolicy: {
            isSourceRepoAllowed: vi.fn().mockResolvedValue({ allowed: true }),
            isWorkflowRepoAllowed: vi
              .fn()
              .mockResolvedValue({ allowed: false, reason: 'not allow-listed' }),
          },
        }) as any;

      await expect(handleRerun('original-run-123', null, null, deps, 'req-g8')).rejects.toThrow(
        /global workflow policy refuses it \(not allow-listed\)/,
      );
      expect(dispatched).not.toHaveBeenCalled();
    });

    it('dispatches once across a failover re-send of the same requestId', async () => {
      const first = await handleRerun('original-run-123', null, null, deps, 'req-g9');
      const second = await handleRerun('original-run-123', null, null, deps, 'req-g9');

      expect(second.newRunId).toBe(first.newRunId);
      expect(dispatched).toHaveBeenCalledTimes(1);
    });

    it("would otherwise have silently run the source repo's same-named workflow", async () => {
      // What routing on the marker prevents: without it the run looks
      // per-repository, so the source repository's own workflow executes.
      const { workflow_repo_identifier: _dropped, ...unmarked } = GLOBAL_RUN;
      deps.db = makeMockDb({ ...unmarked, workflow_name: 'ci' }) as any;

      await handleRerun('original-run-123', null, null, deps, 'req-test');

      expect(providerBundle.lockFileFetcher!.fetchLockFile).toHaveBeenCalledWith(
        SOURCE_REPO,
        's1',
        expect.anything(),
      );
      expect(dispatched.mock.calls[0][0]).toMatchObject({ workflowRepoIdentifier: SOURCE_REPO });
      expect(dispatched.mock.calls[0][0].global).toBeUndefined();
    });

    it('allows a rerun when the workflow lives in the repository the run acted on', async () => {
      // A same-repo value is not a cross-repo dispatch: it takes the
      // per-repository path.
      deps.db = makeMockDb({
        ...TERMINAL_RUN,
        workflow_repo_identifier: TERMINAL_RUN.repo_identifier,
      }) as any;

      await handleRerun('original-run-123', null, null, deps, 'req-test');

      expect(dispatched.mock.calls[0][0].global).toBeUndefined();
    });
  });

  it('throws RunArchivedNotRerunnableError on PG miss when cold-store cannot replay', async () => {
    // A PG miss tries cold-store replay first. With deps.coldStore=null (the
    // harness default) replay is skipped and the gate surfaces the structured
    // archive error, which the Platform proxy maps to HTTP 410.
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

  it('leaves storing the payload to the pipeline, so the new run keeps one parseable copy', async () => {
    await handleRerun('original-run-123', null, null, deps, 'req-test');

    // fails-when: the re-run appends the payload as well as the pipeline
    expect(dispatchedCtx().payload).toEqual(PAYLOAD);
    expect(logStorage.append).not.toHaveBeenCalled();
  });

  // ── `run.rerun.request` orchestrator-side trust model (security invariant) ──
  //
  // Threat: a compromised Platform credential or rogue Platform process driving
  // the Platform→Orchestrator dispatch surface. Trusting Platform on identity
  // attribution (`actor` / `triggeredBy`; the orchestrator has no independent
  // OIDC trust to Keycloak) is by design under the 3-tier auth model and out of
  // scope. The tenant-isolation invariants below are in scope and pinned here.
  describe('tenant-isolation invariants under a rogue Platform', () => {
    it('rejects with RunArchivedNotRerunnableError when cold-store is wired but returns chunkId=null', async () => {
      // Tenant-isolation invariant 1: a Platform-named runId missing from the
      // orchestrator DB with no cold-store match dispatches nothing and records
      // no execution start; `RunArchivedNotRerunnableError` throws first. The
      // `coldStore = null` branch is tested above; this is the branch where the
      // cold store is reachable but no manifest matches the rowId / tenantId pair.
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

      expect(dispatched).not.toHaveBeenCalled();
      expect(eventRouter.emit).not.toHaveBeenCalled();

      // The cold store is consulted with the Platform-supplied routingKeyHint as
      // tenantId. Cross-orchestrator isolation holds at the AWS-IAM layer (each
      // orchestrator has its own KICI_COLD_STORE_BUCKET / KICI_COLD_STORE_PREFIX),
      // so this tenantId can only point at the orchestrator's own bucket prefix.
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
      // Tenant-isolation invariant 3: once `loadAndValidateOriginalRun` returns
      // a row, every operation derives authority from `originalRun.routing_key`
      // (the orchestrator's own DB), NOT the Platform-supplied `routingKeyHint`.
      // A faked hint still runs the lock file and provider bundle of the run's
      // OWN routing key: defense in depth beyond invariant 1's scoped cold store.
      const realKey = 'github:42';
      const attackerHint = 'github:99-rogue';
      db = makeMockDb({ ...TERMINAL_RUN, routing_key: realKey });
      deps.db = db as any;

      await handleRerun('original-run-123', null, null, deps, 'req-test', attackerHint);

      const getByRoutingKey = (
        deps.providerRegistry as unknown as { getByRoutingKey: ReturnType<typeof vi.fn> }
      ).getByRoutingKey;
      const callArgs = getByRoutingKey.mock.calls.map((c) => c[0]);
      expect(callArgs).toContain(realKey);
      expect(callArgs).not.toContain(attackerHint);

      expect(dispatchedCtx().info.routingKey).toBe(realKey);
    });
  });

  /**
   * Re-running a failed global evaluation round re-evaluates the original event.
   *
   * A failed round suppresses every organization-wide workflow it was deciding
   * on and records one errored run. Re-running it re-drives the evaluation for
   * the round's own workflow repository and resolves no workflow out of a lock
   * file, so the cross-repository refusal does not apply.
   */
  describe('re-running a failed global evaluation round', () => {
    const SOURCE_REPO = 'owner/source-repo';
    const WORKFLOW_REPO = 'owner/org-workflows';

    /**
     * The round's run row, also carrying the delivery's `event_log` columns
     * (`event` / `action` / `org_id`), since the mock DB serves one row to every
     * select whose predicates it satisfies. `org_id` matching `customer_id` lets
     * the org-scoped delivery lookup find it; another tenant's `org_id` is the
     * regression case below.
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
     * The request is answered once the claim is taken: the round is an agent
     * job with a budget of minutes, and the relayed dashboard call has ten
     * seconds. So a PASS assertion waits for the detached work, and settling
     * keeps a running re-evaluation away from the next test's mocks.
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
      // A re-evaluation inside the reply outlasts the relay's ten-second budget
      // (every real round does), so the operator gets a gateway timeout while
      // it completes unobserved.
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

      // Answered while the round is still in flight.
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
      // The repository's candidates that needed no round already dispatched on
      // the original delivery; re-evaluating them would run them twice.
      // fails-when: the re-run re-dispatches the workflows the failed round never decided on
      expect(passArgs.onlyRoundCandidates).toBe(true);
      // fails-when: a failed round's re-run marks itself a released hold and re-dispatches result-aware-only siblings
      expect(passArgs.releasedHold).toBeUndefined();
      expect(passArgs.repoIdentifier).toBe(SOURCE_REPO);
      expect(passArgs.ref).toBe('abc123def');
      // No workflow comes from the source repo's lock file, which is why the
      // refusal does not apply.
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
      // Same `delivery_id`, different tenant: another org's generic source picks
      // `X-Delivery-Id` freely, so only org scoping keeps this row out.
      deps.db = makeMockDb({ ...ROUND_RUN, org_id: 'org-2' }) as any;

      await expect(
        handleRerun('original-run-123', null, null, deps, 'req-round-other-org'),
      ).rejects.toThrow(/no event log entry for delivery/);
      expect(dispatchGlobals).not.toHaveBeenCalled();
    });

    it('refuses a round that recorded no workflow repository', async () => {
      // The pass skips source-repository registrations BEFORE applying the
      // scope, so scoping on the source repo evaluates nothing and reports no
      // failure, which the success check would read as clean. No reading of a
      // NULL column re-evaluates anything, so the re-run refuses.
      deps.db = makeMockDb({ ...ROUND_RUN, workflow_repo_identifier: null }) as any;

      await expect(
        handleRerun('original-run-123', 'user@test.com', null, deps, 'req-round-null'),
      ).rejects.toThrow(/records no workflow repository/);
      expect(dispatchGlobals).not.toHaveBeenCalled();
    });

    /**
     * A cross-provider global resolves its lock file through ANOTHER source's
     * bundle, so the round's `provider_context` holds that source's credentials
     * while `routing_key` names the inbound source. Pairing the two hands one
     * source's credentials to the other's API client.
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
      // A coordinator with no pending-eval tracker or registration index
      // suppresses every candidate and deliberately raises no round failure.
      // Reading that silence as clean would flip the gating check to success
      // and unblock a merge bot on work that did not run.
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
      // "Decided" is the positive signal, not "dispatched something": all
      // `run: false` verdicts are a full, clean evaluation.
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
      // A pass the policy did not admit evaluates nothing and reports no round
      // failure; reading that as clean would post success for work never run.
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
      // `normalizeEvent` is read-only, so it runs BEFORE the requestId claim.
      // Claimed first, a failover re-send's second hop would answer HTTP 200
      // with the round's run id, reporting success when nothing ran.
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
  describe('a re-run presents the subject event of the run it repeats', () => {
    /**
     * The OIDC subject derives from `subjectTriggerEvent`. The new row's
     * `trigger_event` is `'rerun'`, not pull-request family, so without it the
     * re-run would present a trusted base-branch push's branch-shaped identity.
     * The head context itself comes from the re-normalized event.
     */
    it('reads the original run own inherited event first, so a re-run of a re-run keeps the shape', async () => {
      deps.db = makeMockDb({
        ...TERMINAL_RUN,
        trigger_event: 'rerun',
        subject_trigger_event: 'pull_request:opened',
      }) as any;

      await handleRerun('original-run-123', null, null, deps, 'req-rerun-of-rerun');

      expect(dispatchedCtx().subjectTriggerEvent).toBe('pull_request:opened');
    });

    it('inherits nothing when the original run recorded no event at all', async () => {
      deps.db = makeMockDb({
        ...TERMINAL_RUN,
        trigger_event: null,
        subject_trigger_event: null,
      }) as any;

      await handleRerun('original-run-123', null, null, deps, 'req-rerun-no-event');

      // No subject event means "use `trigger_event`", never a guess.
      expect('subjectTriggerEvent' in dispatchedCtx()).toBe(false);
    });
  });
});
