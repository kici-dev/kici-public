import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildManualJobConfig,
  handleManualSchedule,
  mergeScheduleInputs,
} from './manual-schedule.js';
import type { LockScheduleTrigger, LockWorkflow, MaterializedJob } from '@kici-dev/engine';

// Mock the idempotency claim with an in-memory stateful implementation so the
// `handleManualSchedule` wiring — a `claimed: false` re-send short-circuits
// before dispatch — is exercised deterministically without a real DB. Real
// `INSERT … ON CONFLICT` dedup is covered in `request-idempotency.test.ts`.
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
      const id = `mock-schedule-run-${++counter}`;
      claims.set(requestId, id);
      return { newRunId: id, claimed: true };
    },
  };
});

vi.mock('./request-idempotency.js', () => ({
  claimRequestId: vi.fn(async (_db: unknown, requestId: string) => idempotency.claim(requestId)),
  pruneRequestIdempotency: vi.fn(async () => 0),
}));

function makeRegistration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'reg-abc',
    repoIdentifier: 'owner/repo',
    routingKey: 'github:42',
    workflowName: 'heartbeat',
    commitSha: 'abc123def',
    providerContext: { installationId: 42 },
    disabled: false,
    lockEntry: {
      name: 'heartbeat',
      source: '.kici/workflows/heartbeat.ts',
      contentHash: 'content-hash-1',
      triggers: [{ _type: 'schedule', cron: '0 * * * *' }],
      jobs: [
        {
          _type: 'static',
          name: 'beat',
          runsOn: [{ kind: 'exact', value: 'default' }],
          steps: [{ name: 'ping', run: 'echo ok' }],
          needs: [],
        },
      ],
    },
    ...overrides,
  };
}

function makeDeps(registration: ReturnType<typeof makeRegistration> | null) {
  const dispatcher = {
    dispatch: vi.fn().mockResolvedValue({ status: 'dispatched', agentId: 'a1', jobId: 'j1' }),
  };
  const executionTracker = {
    onExecutionStarted: vi.fn().mockResolvedValue(undefined),
    onJobStatus: vi.fn().mockResolvedValue(undefined),
    addJobsToRun: vi.fn().mockResolvedValue(undefined),
  };
  const providerBundle = {
    repoUrlBuilder: {
      buildCloneUrl: vi.fn().mockImplementation((id: string) => `https://github.com/${id}.git`),
    },
  };
  const providerRegistry = {
    getByRoutingKey: vi.fn().mockReturnValue(providerBundle),
  };
  const registrationIndex = {
    getById: vi.fn().mockReturnValue(registration),
  };
  const eventRouter = { emit: vi.fn().mockResolvedValue(undefined) };

  return {
    deps: {
      dispatcher,
      executionTracker,
      providerRegistry,
      registrationIndex,
      eventRouter,
    } as never,
    dispatcher,
    executionTracker,
  };
}

describe('handleManualSchedule', () => {
  let harness: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    idempotency.reset();
    harness = makeDeps(makeRegistration());
  });

  it('dispatches with ref="" so the agent clones the default branch (not --branch HEAD)', async () => {
    const result = await handleManualSchedule(
      'reg-abc',
      'user@test.com',
      null,
      harness.deps,
      'req-test',
    );

    expect(result.newRunId).toBeDefined();
    expect(harness.dispatcher.dispatch).toHaveBeenCalledOnce();

    const input = harness.dispatcher.dispatch.mock.calls[0][0];
    expect(input.ref).toBe('');
    expect(input.sha).toBe('abc123def');
    expect(input.repoUrl).toBe('https://github.com/owner/repo.git');
  });

  it('is idempotent on requestId: a failover re-send returns the same run without a second dispatch', async () => {
    const requestId = 'req-schedule-dedupe';
    const first = await handleManualSchedule(
      'reg-abc',
      'user@test.com',
      null,
      harness.deps,
      requestId,
    );
    const second = await handleManualSchedule(
      'reg-abc',
      'user@test.com',
      null,
      harness.deps,
      requestId,
    );

    expect(second.newRunId).toBe(first.newRunId);
    // Only the first hop created + dispatched the run; the re-send short-circuits.
    expect(harness.dispatcher.dispatch).toHaveBeenCalledOnce();
    expect(harness.executionTracker.onExecutionStarted).toHaveBeenCalledOnce();
  });

  it('records execution with ref="" in executionTracker (matches automatic cron path)', async () => {
    await handleManualSchedule('reg-abc', 'user@test.com', null, harness.deps, 'req-test');

    expect(harness.executionTracker.onExecutionStarted).toHaveBeenCalledOnce();
    const args = harness.executionTracker.onExecutionStarted.mock.calls[0];
    expect(args[4]).toBe('');
    expect(args[5]).toBe('abc123def');
  });

  it('expands a matrix job into N dispatches each carrying matrixValues', async () => {
    harness = makeDeps(
      makeRegistration({
        lockEntry: {
          name: 'heartbeat',
          source: '.kici/workflows/heartbeat.ts',
          contentHash: 'content-hash-1',
          triggers: [{ _type: 'schedule', cron: '0 * * * *' }],
          jobs: [
            {
              _type: 'static',
              name: 'beat',
              runsOn: [{ kind: 'exact', value: 'default' }],
              steps: [{ name: 'ping', run: 'echo ok' }],
              needs: [],
              matrix: { _type: 'static', values: ['a', 'b'] },
            },
          ],
        },
      }),
    );

    await handleManualSchedule('reg-abc', 'user@test.com', null, harness.deps, 'req-test');

    expect(harness.dispatcher.dispatch).toHaveBeenCalledTimes(2);
    const calls = harness.dispatcher.dispatch.mock.calls.map((c: any[]) => c[0]);
    const byName = Object.fromEntries(calls.map((c: any) => [c.jobName, c]));
    expect(Object.keys(byName).sort()).toEqual(['beat (a)', 'beat (b)']);
    expect(byName['beat (a)'].jobConfig.matrixValues).toEqual({ value: 'a' });
    expect(byName['beat (a)'].jobConfig.baseJobName).toBe('beat');
    expect(byName['beat (a)'].jobConfig.matrix).toBeUndefined();
  });

  it('degrades gracefully when one matrix job can no longer expand (FanoutError)', async () => {
    harness = makeDeps(
      makeRegistration({
        lockEntry: {
          name: 'heartbeat',
          source: '.kici/workflows/heartbeat.ts',
          contentHash: 'content-hash-1',
          triggers: [{ _type: 'schedule', cron: '0 * * * *' }],
          jobs: [
            {
              _type: 'static',
              name: 'bad',
              runsOn: [{ kind: 'exact', value: 'default' }],
              steps: [{ name: 'ping', run: 'echo ok' }],
              needs: [],
              // Static matrix with no `values` → materializeFanout throws FanoutError.
              matrix: { _type: 'static' },
            },
            {
              _type: 'static',
              name: 'good',
              runsOn: [{ kind: 'exact', value: 'default' }],
              steps: [{ name: 'ping', run: 'echo ok' }],
              needs: [],
            },
          ],
        },
      }),
    );

    const result = await handleManualSchedule(
      'reg-abc',
      'user@test.com',
      null,
      harness.deps,
      'req-test',
    );

    // The whole manual trigger no longer fails wholesale — the good job dispatches.
    expect(result.newRunId).toBeDefined();
    expect(harness.dispatcher.dispatch).toHaveBeenCalledOnce();
    expect(harness.dispatcher.dispatch.mock.calls[0][0].jobName).toBe('good');
    // Both jobs are registered: the surviving 'good' job plus the synthetic
    // rejected entry for 'bad'.
    expect(harness.executionTracker.addJobsToRun).toHaveBeenCalledOnce();
    const registered = harness.executionTracker.addJobsToRun.mock.calls[0][1];
    expect(registered.some((j: { jobName: string }) => j.jobName === 'good')).toBe(true);
    expect(registered.some((j: { jobName: string }) => j.jobName === 'bad')).toBe(true);
    // The synthetic-rejected 'bad' job is marked failed.
    expect(harness.executionTracker.onJobStatus).toHaveBeenCalled();
  });

  it('throws if registration is missing', async () => {
    const h = makeDeps(null);
    await expect(
      handleManualSchedule('reg-missing', null, null, h.deps, 'req-test'),
    ).rejects.toThrow('Registration not found');
  });

  it('throws if registration is disabled', async () => {
    const h = makeDeps(makeRegistration({ disabled: true }));
    await expect(handleManualSchedule('reg-abc', null, null, h.deps, 'req-test')).rejects.toThrow(
      'Workflow is disabled',
    );
  });

  it('throws if registration has no commit SHA', async () => {
    const h = makeDeps(makeRegistration({ commitSha: null }));
    await expect(handleManualSchedule('reg-abc', null, null, h.deps, 'req-test')).rejects.toThrow(
      'Registration has no commit SHA',
    );
  });

  it('throws if workflow has no schedule trigger', async () => {
    const h = makeDeps(
      makeRegistration({
        lockEntry: {
          name: 'heartbeat',
          source: '.kici/workflows/heartbeat.ts',
          triggers: [{ _type: 'push', branches: ['main'] }],
          jobs: [],
        },
      }),
    );
    await expect(handleManualSchedule('reg-abc', null, null, h.deps, 'req-test')).rejects.toThrow(
      'Workflow has no schedule trigger',
    );
  });

  it('routes via the cluster coordinator when one is available (cross-peer manual trigger)', async () => {
    const h = makeDeps(makeRegistration());
    const coordinator = {
      routeJobs: vi.fn().mockResolvedValue({
        localJobs: [],
        reroutedJobs: [{ jobName: 'beat', peerId: 'host-1-stg' }],
        failedJobs: [],
      }),
    };
    (h.deps as any).coordinator = coordinator;

    await handleManualSchedule('reg-abc', 'user@test.com', null, h.deps, 'req-test');

    expect(coordinator.routeJobs).toHaveBeenCalledOnce();
    const [runCtx, jobs] = coordinator.routeJobs.mock.calls[0];
    expect(runCtx.routingKey).toBe('github:42');
    expect(runCtx.event).toBe('manual_schedule');
    expect(runCtx.ref).toBe('');
    expect(runCtx.sha).toBe('abc123def');
    expect(runCtx.installationId).toBe(42);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].jobName).toBe('beat');
    expect(jobs[0].ref).toBe('');
    // Inner labels are double-wrapped as required by RunCoordinator
    expect(jobs[0].runsOnLabels).toEqual([['default']]);

    // Standalone dispatch was NOT called — coordinator owns dispatch
    expect(h.dispatcher.dispatch).not.toHaveBeenCalled();
  });

  // ── `run.manual_schedule.request` orch-side trust model (security invariant) ──
  //
  // Pentest catalog at
  // — Platform→Orchestrator dispatch surface under attacker model A10
  // (compromised Platform credential / rogue Platform process). The wire schema
  // (`packages/engine/src/protocol/messages/dashboard.ts:145`) carries only
  // `requestId`, `actor`, and `registrationId` — no Platform-supplied routing
  // data, lock-file content, or commit SHA. The orchestrator looks up the
  // registration in its OWN local `registrationIndex` (single-tenant), and all
  // downstream operations (repoUrl, sha, providerContext, routing key) come
  // from the registration record. Cross-tenant isolation is therefore enforced
  // by construction: a rogue Platform that names a `registrationId` not in
  // this orchestrator's registry cannot drive any side effect.
  //
  // The four enforcement branches in `validateScheduleRequest` are already
  // covered as "feature" tests above (Registration not found / Workflow is
  // disabled / no schedule trigger / no commit SHA). The tests below pin the
  // *side-effect-freeness* invariant explicitly — a rejected request MUST
  // NOT call `dispatcher.dispatch`, `executionTracker.onExecutionStarted`,
  // or `eventRouter.emit`. The audit-attribution caveat (`triggeredBy` is
  // Platform-supplied) is identical to and is by-design under the
  // 3-tier auth model — out of scope for §3 customer isolation.
  describe('tenant-isolation invariants under rogue Platform (A10)', () => {
    it('forged registrationId (not in local index) is side-effect-free', async () => {
      const h = makeDeps(null);
      await expect(
        handleManualSchedule('forged-reg-id', null, null, h.deps, 'req-test'),
      ).rejects.toThrow('Registration not found');
      expect(h.dispatcher.dispatch).not.toHaveBeenCalled();
      expect(h.executionTracker.onExecutionStarted).not.toHaveBeenCalled();
      expect(h.executionTracker.addJobsToRun).not.toHaveBeenCalled();
      expect(
        (h.deps as { eventRouter: { emit: ReturnType<typeof vi.fn> } }).eventRouter.emit,
      ).not.toHaveBeenCalled();
    });

    it('disabled registration is side-effect-free', async () => {
      const h = makeDeps(makeRegistration({ disabled: true }));
      await expect(handleManualSchedule('reg-abc', null, null, h.deps, 'req-test')).rejects.toThrow(
        'Workflow is disabled',
      );
      expect(h.dispatcher.dispatch).not.toHaveBeenCalled();
      expect(h.executionTracker.onExecutionStarted).not.toHaveBeenCalled();
      expect(h.executionTracker.addJobsToRun).not.toHaveBeenCalled();
      expect(
        (h.deps as { eventRouter: { emit: ReturnType<typeof vi.fn> } }).eventRouter.emit,
      ).not.toHaveBeenCalled();
    });

    it('non-schedule-triggered registration cannot be manually triggered (side-effect-free)', async () => {
      // The schedule-only restriction prevents Platform from using
      // `run.manual_schedule.request` to dispatch arbitrary registrations
      // that just happen to exist on this orchestrator (e.g., push- or
      // pull_request-triggered workflows). Without this gate, the rerun
      // surface would have an alternate dispatch path with a
      // strictly looser trust model.
      const h = makeDeps(
        makeRegistration({
          lockEntry: {
            name: 'ci',
            source: '.kici/workflows/ci.ts',
            triggers: [{ _type: 'push', branches: ['main'] }],
            jobs: [],
          },
        }),
      );
      await expect(handleManualSchedule('reg-abc', null, null, h.deps, 'req-test')).rejects.toThrow(
        'Workflow has no schedule trigger',
      );
      expect(h.dispatcher.dispatch).not.toHaveBeenCalled();
      expect(h.executionTracker.onExecutionStarted).not.toHaveBeenCalled();
      expect(h.executionTracker.addJobsToRun).not.toHaveBeenCalled();
      expect(
        (h.deps as { eventRouter: { emit: ReturnType<typeof vi.fn> } }).eventRouter.emit,
      ).not.toHaveBeenCalled();
    });
  });
});

function fakeScheduleWorkflow(inputs?: Record<string, unknown>): LockWorkflow {
  return {
    name: 'sched-wf',
    source: 'test/repo',
    triggers: [
      {
        _type: 'schedule',
        cronExpression: '0 0 * * *',
        timezone: 'UTC',
        ...(inputs && { inputs }),
      },
    ],
    jobs: [],
  } as unknown as LockWorkflow;
}

function fakeMat(): MaterializedJob {
  return {
    expandedName: 'j',
    baseName: 'j',
    lockJob: { _type: 'static', name: 'j', steps: [], needs: [], rules: [] },
  } as unknown as MaterializedJob;
}

describe('buildManualJobConfig dispatchInputs', () => {
  it('stamps defaults-only schedule inputs onto the job config', () => {
    const wf = fakeScheduleWorkflow({
      mode: { type: 'enum', values: ['full', 'quick'], default: 'full' },
    });
    const cfg = buildManualJobConfig(wf, fakeMat());
    expect(cfg.dispatchInputs).toEqual({ mode: 'full' });
  });

  it('omits dispatchInputs when the schedule declares no inputs', () => {
    const cfg = buildManualJobConfig(fakeScheduleWorkflow(), fakeMat());
    expect('dispatchInputs' in cfg).toBe(false);
  });

  it('merges defaults across ALL schedule triggers on a manual fire', () => {
    const wf = {
      name: 'multi-sched-wf',
      source: 'test/repo',
      triggers: [
        {
          _type: 'schedule',
          cronExpression: '0 9 * * 1',
          timezone: 'UTC',
          inputs: { mode: { type: 'enum', values: ['full', 'quick'], default: 'full' } },
        },
        {
          _type: 'schedule',
          cronExpression: '0 18 * * 5',
          timezone: 'UTC',
          inputs: { region: { type: 'string', default: 'eu' } },
        },
      ],
      jobs: [],
    } as unknown as LockWorkflow;
    const cfg = buildManualJobConfig(wf, fakeMat());
    expect(cfg.dispatchInputs).toEqual({ mode: 'full', region: 'eu' });
  });
});

describe('mergeScheduleInputs', () => {
  it('returns undefined when no schedule declares inputs', () => {
    const triggers = [
      { _type: 'schedule', cronExpression: '0 9 * * 1', timezone: 'UTC' },
      { _type: 'schedule', cronExpression: '0 18 * * 5', timezone: 'UTC' },
    ] as unknown as LockScheduleTrigger[];
    expect(mergeScheduleInputs(triggers)).toBeUndefined();
  });

  it('merges defaults across schedules (later wins on key collision)', () => {
    const triggers = [
      {
        _type: 'schedule',
        cronExpression: '0 9 * * 1',
        timezone: 'UTC',
        inputs: { mode: { type: 'enum', values: ['full', 'quick'], default: 'full' } },
      },
      {
        _type: 'schedule',
        cronExpression: '0 18 * * 5',
        timezone: 'UTC',
        inputs: { mode: { type: 'enum', values: ['full', 'quick'], default: 'quick' } },
      },
    ] as unknown as LockScheduleTrigger[];
    expect(mergeScheduleInputs(triggers)).toEqual({ mode: 'quick' });
  });
});
