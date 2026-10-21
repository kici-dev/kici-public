import { settleAcceptedDispatches } from './accepted-dispatch.js';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { handleManualSchedule, mergeScheduleInputs } from './manual-schedule.js';
import type { LockScheduleTrigger } from '@kici-dev/engine';
import { staticJob } from '../__test-helpers__/lock-fixtures.js';

// An in-memory idempotency claim exercises the wiring (a `claimed: false` re-send
// short-circuits before dispatch) without a DB; real `INSERT … ON CONFLICT` dedup
// is covered in `request-idempotency.test.ts`.
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

// The internal-event pipeline has its own suite; stubbed so tests observe the
// event, context and overrides a fire by hand dispatches with.
const internalPipeline = vi.hoisted(() => ({
  spy: null as null | Mock<(...args: unknown[]) => Promise<unknown>>,
}));

vi.mock('./internal-event-pipeline.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./internal-event-pipeline.js')>();
  return {
    ...actual,
    dispatchInternalEventViaPipeline: (...args: unknown[]) => internalPipeline.spy!(...args),
  };
});

function makeRegistration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'reg-abc',
    repoIdentifier: 'owner/repo',
    routingKey: 'github:42',
    customerId: 'org-7',
    workflowName: 'heartbeat',
    commitSha: 'abc123def',
    defaultBranch: 'main',
    providerContext: { installationId: 42 },
    disabled: false,
    lockEntry: {
      name: 'heartbeat',
      source: { file: '.kici/workflows/heartbeat.ts', export: '#default' },
      contentHash: 'content-hash-1',
      triggers: [
        {
          _type: 'schedule',
          cronExpression: '0 * * * *',
          timezone: 'UTC',
          inputs: { mode: { type: 'enum', values: ['full', 'quick'], default: 'full' } },
        },
        {
          _type: 'schedule',
          cronExpression: '0 9 * * 1',
          timezone: 'UTC',
          inputs: { region: { type: 'string', default: 'eu' } },
        },
      ],
      jobs: [
        staticJob({
          name: 'beat',
          runsOn: [{ kind: 'exact', value: 'default' }],
          steps: [{ name: 'ping', run: 'echo ok' }],
        }),
      ],
    },
    ...overrides,
  };
}

function makeDeps(registration: ReturnType<typeof makeRegistration> | null) {
  const providerBundle = { normalizer: { provider: 'github' } };
  const eventRouter = { emit: vi.fn().mockResolvedValue(undefined) };
  const processingDeps = { orchestratorMode: 'platform' };
  const executionTracker = { recordAcceptedDispatchFailure: vi.fn().mockResolvedValue(undefined) };
  return {
    deps: {
      providerRegistry: { getByRoutingKey: vi.fn().mockReturnValue(providerBundle) },
      registrationIndex: { getById: vi.fn().mockReturnValue(registration) },
      eventRouter,
      executionTracker,
      processingDeps: () => processingDeps,
    } as never,
    eventRouter,
    executionTracker,
    providerBundle,
    processingDeps,
  };
}

describe('handleManualSchedule', () => {
  let harness: ReturnType<typeof makeDeps>;
  let dispatched: Mock<(...args: unknown[]) => Promise<unknown>>;

  beforeEach(() => {
    idempotency.reset();
    harness = makeDeps(makeRegistration());
    dispatched = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({});
    internalPipeline.spy = dispatched;
  });

  afterEach(() => {
    internalPipeline.spy = null;
  });

  it('fires the schedule through the internal-event pipeline a cron fire takes', async () => {
    const { newRunId } = await handleManualSchedule(
      'reg-abc',
      'user@test.com',
      null,
      harness.deps,
      'req-test',
    );
    await settleAcceptedDispatches();

    // fails-when: the fire hand-builds its own job config, which drops needs
    // ordering, contexts, containers and the cache identity every artifact
    // request is resolved against
    expect(dispatched).toHaveBeenCalledOnce();
    const [decision, lockFile, ctx, deps, overrides] = dispatched.mock.calls[0] as any[];
    expect(decision).toMatchObject({ workflowName: 'heartbeat', matched: true });
    expect(lockFile.workflows.map((w: { name: string }) => w.name)).toEqual(['heartbeat']);
    expect(ctx).toMatchObject({
      event: {
        id: `manual_schedule:${newRunId}`,
        eventName: '__schedule_fire',
        payload: { commitSha: 'abc123def' },
      },
      routingKey: 'github:42',
      repoIdentifier: 'owner/repo',
      providerContext: { installationId: 42 },
      cronCommitSha: 'abc123def',
      registrationDefaultBranch: 'main',
    });
    expect(ctx.bundle).toBe(harness.providerBundle);
    expect(deps).toBe(harness.processingDeps);
    expect(overrides).toEqual({
      runId: newRunId,
      triggerEvent: 'manual_schedule',
      triggeredBy: 'user@test.com',
      triggeredByAgentLabel: null,
      // A fire names no schedule, so the defaults of every schedule() trigger merge.
      dispatchInputs: { mode: 'full', region: 'eu' },
    });
    expect(harness.eventRouter.emit).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: 'workflow.manual_schedule' }),
    );
  });

  it('passes no dispatch inputs when no schedule declares any', async () => {
    const entry = makeRegistration().lockEntry;
    harness = makeDeps(
      makeRegistration({
        lockEntry: {
          ...entry,
          triggers: entry.triggers.map(({ inputs: _inputs, ...t }) => t),
        },
      }),
    );

    await handleManualSchedule('reg-abc', null, null, harness.deps, 'req-test');
    await settleAcceptedDispatches();

    expect('dispatchInputs' in (dispatched.mock.calls[0][4] as object)).toBe(false);
  });

  it('is idempotent on requestId: a failover re-send returns the same run without a second dispatch', async () => {
    const requestId = 'req-schedule-dedupe';
    const first = await handleManualSchedule('reg-abc', 'u', null, harness.deps, requestId);
    const second = await handleManualSchedule('reg-abc', 'u', null, harness.deps, requestId);
    await settleAcceptedDispatches();

    expect(second.newRunId).toBe(first.newRunId);
    // fails-when: the lost claim answers without the flag, so the client cannot tell
    expect(second.alreadyAccepted).toBe(true);
    // breaks-if-wrong: the winning claim must not claim an earlier delivery
    expect(first).not.toHaveProperty('alreadyAccepted');
    // fails-when: a lost claim starts a second dispatch
    expect(dispatched).toHaveBeenCalledOnce();
  });

  describe('answered once accepted', () => {
    function holdDispatch(): { release: () => void } {
      let release: () => void = () => {};
      dispatched.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () => resolve({});
          }),
      );
      return { release: () => release() };
    }

    it('answers before its dispatch settles, and emits only after the dispatch', async () => {
      const held = holdDispatch();
      // fails-when: the handler awaits the dispatch, so it never answers while
      // the dispatch is held
      const answer = await Promise.race([
        handleManualSchedule('reg-abc', 'u', null, harness.deps, 'req-early'),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 1_000)),
      ]);
      expect(answer).toEqual({ newRunId: 'mock-schedule-run-1' });
      await vi.waitFor(() => expect(dispatched).toHaveBeenCalledOnce());
      expect(harness.eventRouter.emit).not.toHaveBeenCalled();

      held.release();
      await settleAcceptedDispatches();
      expect(harness.eventRouter.emit).toHaveBeenCalledWith(
        expect.objectContaining({ eventName: 'workflow.manual_schedule' }),
      );
      expect(harness.executionTracker.recordAcceptedDispatchFailure).not.toHaveBeenCalled();
    });

    it('fails the accepted run when its dispatch throws', async () => {
      dispatched.mockRejectedValue(new Error('source cache unreachable'));

      const { newRunId } = await handleManualSchedule(
        'reg-abc',
        'user@test.com',
        'ci-bot',
        harness.deps,
        'req-throws',
      );
      await settleAcceptedDispatches();

      expect(harness.executionTracker.recordAcceptedDispatchFailure).toHaveBeenCalledOnce();
      expect(harness.executionTracker.recordAcceptedDispatchFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: newRunId,
          failureReason: 'Schedule fired by hand could not be dispatched: source cache unreachable',
          workflowName: 'heartbeat',
          provider: 'github',
          repoIdentifier: 'owner/repo',
          ref: 'main',
          sha: 'abc123def',
          routingKey: 'github:42',
          providerContext: { installationId: 42 },
          deliveryId: `manual_schedule:${newRunId}`,
          triggerEvent: 'manual_schedule',
          triggeredBy: 'user@test.com',
          triggeredByAgentLabel: 'ci-bot',
        }),
      );
      expect(harness.eventRouter.emit).not.toHaveBeenCalled();
    });

    it('keeps a dispatched run when the event emit fails', async () => {
      harness.eventRouter.emit.mockRejectedValue(new Error('event store down'));

      await handleManualSchedule('reg-abc', null, null, harness.deps, 'req-emit-fails');
      await settleAcceptedDispatches();

      // breaks-if-wrong: a failed emit after a good dispatch must not fail the live run
      expect(dispatched).toHaveBeenCalledOnce();
      expect(harness.executionTracker.recordAcceptedDispatchFailure).not.toHaveBeenCalled();
    });
  });

  it('throws if registration has no commit SHA', async () => {
    const h = makeDeps(makeRegistration({ commitSha: null }));
    await expect(handleManualSchedule('reg-abc', null, null, h.deps, 'req-test')).rejects.toThrow(
      'Registration has no commit SHA',
    );
  });

  // ── `run.manual_schedule.request` orch-side trust model (security invariant) ──
  //
  // Threat: a compromised Platform credential or rogue Platform process driving
  // the Platform→Orchestrator dispatch surface. The wire schema
  // (`manualScheduleRequestSchema` in `packages/engine/src/protocol/messages/dashboard.ts`)
  // carries only `requestId`, `actor` and `registrationId` — no routing data,
  // lock-file content or commit SHA. The orchestrator resolves the registration
  // in its OWN local `registrationIndex` (single-tenant), and every downstream
  // value (sha, providerContext, routing key) comes from that record, so a
  // `registrationId` not in this orchestrator's registry drives no side effect.
  // A rejected request MUST NOT dispatch or emit.
  describe('tenant-isolation invariants under a rogue Platform', () => {
    function expectNoSideEffect(h: ReturnType<typeof makeDeps>): void {
      expect(dispatched).not.toHaveBeenCalled();
      expect(h.eventRouter.emit).not.toHaveBeenCalled();
    }

    it('forged registrationId (not in local index) is side-effect-free', async () => {
      const h = makeDeps(null);
      await expect(
        handleManualSchedule('forged-reg-id', null, null, h.deps, 'req-test'),
      ).rejects.toThrow('Registration not found');
      expectNoSideEffect(h);
    });

    it('disabled registration is side-effect-free', async () => {
      const h = makeDeps(makeRegistration({ disabled: true }));
      await expect(handleManualSchedule('reg-abc', null, null, h.deps, 'req-test')).rejects.toThrow(
        'Workflow is disabled',
      );
      expectNoSideEffect(h);
    });

    it('non-schedule-triggered registration cannot be manually triggered (side-effect-free)', async () => {
      // The schedule-only restriction stops the Platform from using
      // `run.manual_schedule.request` to dispatch any registration on this
      // orchestrator (e.g. push- or pull_request-triggered workflows).
      const h = makeDeps(
        makeRegistration({
          lockEntry: {
            ...makeRegistration().lockEntry,
            triggers: [{ _type: 'push', branches: ['main'] }],
          },
        }),
      );
      await expect(handleManualSchedule('reg-abc', null, null, h.deps, 'req-test')).rejects.toThrow(
        'Workflow has no schedule trigger',
      );
      expectNoSideEffect(h);
    });
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
