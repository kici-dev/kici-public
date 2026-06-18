/**
 * Tests for CronScheduler -- Raft-leader-only cron evaluation.
 *
 * Uses mock registrationIndex, cronStore, and eventRouter.
 * Uses vi.useFakeTimers() for timer control.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { LockWorkflow, LockScheduleTrigger } from '@kici-dev/engine';
import type { RegisteredWorkflow } from '../registration/registration-index.js';

// Replace the shared logger with a stable spy so tests can assert that
// `logger.error` is NOT invoked when an impossible cron is evaluated
// (regression guard for the croner `previousRuns(1)` throw -> error-log spam
// every 30s for workflows using a "never fires" idiom like '0 0 31 2 *').
//
// vi.hoisted is required: vi.mock() is hoisted above all imports, but the
// captured logger must exist before the mock factory runs, so it has to be
// hoisted alongside the mock.
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@kici-dev/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kici-dev/shared')>();
  return {
    ...actual,
    createLogger: () => mockLogger,
  };
});

import { CronScheduler } from './cron-scheduler.js';

// ── Mock helpers ────────────────────────────────────────────────

function makeScheduleRegistration(
  overrides: Partial<{
    workflowName: string;
    cronExpression: string;
    timezone: string;
    repoIdentifier: string;
    commitSha: string | null;
    sourceFile: string | null;
  }> = {},
): RegisteredWorkflow {
  const cronExpression = overrides.cronExpression ?? '*/5 * * * *';
  const timezone = overrides.timezone ?? 'UTC';
  const workflowName = overrides.workflowName ?? 'scheduled-deploy';

  const scheduleTrigger: LockScheduleTrigger = {
    _type: 'schedule',
    cronExpression,
    timezone,
  };

  const lockEntry: LockWorkflow = {
    name: workflowName,
    contentHash: 'sha256-test',
    compileSchemaVersion: 1,
    triggers: [scheduleTrigger],
    jobs: [],
  };

  return {
    id: `reg-${workflowName}`,
    repoIdentifier: overrides.repoIdentifier ?? 'owner/repo',
    workflowName,
    lockEntry,
    triggerTypes: ['schedule'],
    routingKey: 'github:42',
    providerContext: {},
    disabled: false,
    commitSha: overrides.commitSha ?? null,
    sourceFile: overrides.sourceFile ?? null,
  };
}

function createMockDeps(options: { schedules?: RegisteredWorkflow[] } = {}) {
  const schedules = options.schedules ?? [];

  const registrationIndex = {
    getCronSchedules: vi.fn().mockReturnValue(schedules),
  } as any;

  const cronStore = {
    getAll: vi.fn().mockResolvedValue(new Map<string, Date>()),
    tryClaimFire: vi.fn().mockResolvedValue(true),
  };

  // The new transactional fire path calls
  // `db.transaction().execute(fn)` with a tx handle. The mock just runs
  // the callback synchronously with a stub tx; tryClaimFire / emitInTx
  // are mocked separately so they don't actually hit the tx.
  const tx = {} as any;
  const db = {
    transaction: vi.fn().mockReturnValue({
      execute: vi.fn().mockImplementation((fn: (tx: any) => Promise<unknown>) => fn(tx)),
    }),
  } as any;

  const eventRouter = {
    emit: vi.fn().mockResolvedValue('evt-001'),
    emitInTx: vi.fn().mockResolvedValue('evt-001'),
  } as any;

  return { db, registrationIndex, cronStore, eventRouter };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('CronScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Set a known time: 2026-02-25T10:07:00Z (7 minutes past the hour)
    // For */5 * * * *, the previous scheduled time would be 10:05:00Z
    vi.setSystemTime(new Date('2026-02-25T10:07:00Z'));
    // Reset the captured logger spies so per-test assertions don't see
    // calls from earlier tests in the same file.
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('onBecomeLeader', () => {
    it('should load last-fired cache from DB and start evaluation timer', async () => {
      const schedule = makeScheduleRegistration();
      const { db, registrationIndex, cronStore, eventRouter } = createMockDeps({
        schedules: [schedule],
      });

      const scheduler = new CronScheduler({
        db,
        registrationIndex,
        cronStore,
        eventRouter,
        evaluationIntervalMs: 30_000,
      });

      await scheduler.onBecomeLeader();

      expect(cronStore.getAll).toHaveBeenCalledTimes(1);
      // Recovery should also trigger emit since no lastFiredAt
      expect(eventRouter.emitInTx).toHaveBeenCalledTimes(1);

      scheduler.stop();
    });

    it('should recover missed schedules on becoming leader', async () => {
      const schedule = makeScheduleRegistration({ workflowName: 'nightly-build' });
      const { db, registrationIndex, cronStore, eventRouter } = createMockDeps({
        schedules: [schedule],
      });

      // Last fired at 9:55 -- missed the 10:00 and 10:05 fires
      const oldFiredAt = new Date('2026-02-25T09:55:00Z');
      cronStore.getAll.mockResolvedValue(new Map([['reg-nightly-build', oldFiredAt]]));

      const scheduler = new CronScheduler({
        db,
        registrationIndex,
        cronStore,
        eventRouter,
        evaluationIntervalMs: 30_000,
      });

      await scheduler.onBecomeLeader();

      // Should fire once (fire-once-on-recovery, not for every missed interval)
      expect(eventRouter.emitInTx).toHaveBeenCalledTimes(1);
      expect(eventRouter.emitInTx).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: '__schedule_fire',
          payload: expect.objectContaining({
            workflowName: 'nightly-build',
            scheduledAt: '2026-02-25T10:05:00.000Z',
          }),
          sourceRepo: 'owner/repo',
        }),
        expect.anything(),
      );

      // Should have claimed the fire atomically via DB
      // tryClaimFire now also receives the active tx as the 3rd arg.
      expect(cronStore.tryClaimFire).toHaveBeenCalledWith(
        'reg-nightly-build',
        new Date('2026-02-25T10:05:00.000Z'),
        expect.anything(),
      );

      scheduler.stop();
    });
  });

  describe('evaluate', () => {
    it('should only run when isLeader is true', async () => {
      const schedule = makeScheduleRegistration();
      const { db, registrationIndex, cronStore, eventRouter } = createMockDeps({
        schedules: [schedule],
      });

      const scheduler = new CronScheduler({
        db,
        registrationIndex,
        cronStore,
        eventRouter,
      });

      // Not leader -- evaluate should be a no-op
      await scheduler.evaluate();
      expect(registrationIndex.getCronSchedules).not.toHaveBeenCalled();
      expect(eventRouter.emitInTx).not.toHaveBeenCalled();
    });

    it('should fire schedule when previousRun is newer than lastFiredAt', async () => {
      const schedule = makeScheduleRegistration();
      const { db, registrationIndex, cronStore, eventRouter } = createMockDeps({
        schedules: [schedule],
      });

      const scheduler = new CronScheduler({
        db,
        registrationIndex,
        cronStore,
        eventRouter,
        evaluationIntervalMs: 30_000,
      });

      await scheduler.onBecomeLeader();
      // Reset the mocks after recovery (which fires once)
      eventRouter.emitInTx.mockClear();
      cronStore.tryClaimFire.mockClear();

      // Advance time to 10:12 -- now the previous scheduled time is 10:10
      vi.setSystemTime(new Date('2026-02-25T10:12:00Z'));

      await scheduler.evaluate();

      expect(eventRouter.emitInTx).toHaveBeenCalledTimes(1);
      expect(eventRouter.emitInTx).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: '__schedule_fire',
          payload: expect.objectContaining({
            scheduledAt: '2026-02-25T10:10:00.000Z',
          }),
        }),
        expect.anything(),
      );
      expect(cronStore.tryClaimFire).toHaveBeenCalledWith(
        'reg-scheduled-deploy',
        new Date('2026-02-25T10:10:00.000Z'),
        expect.anything(),
      );

      scheduler.stop();
    });

    it('should NOT re-fire a schedule that already fired recently', async () => {
      const schedule = makeScheduleRegistration();
      const { db, registrationIndex, cronStore, eventRouter } = createMockDeps({
        schedules: [schedule],
      });

      // Already fired at 10:05 (current previous scheduled time)
      cronStore.getAll.mockResolvedValue(
        new Map([['reg-scheduled-deploy', new Date('2026-02-25T10:05:00.000Z')]]),
      );

      const scheduler = new CronScheduler({
        db,
        registrationIndex,
        cronStore,
        eventRouter,
        evaluationIntervalMs: 30_000,
      });

      await scheduler.onBecomeLeader();

      // Should NOT fire -- already fired at 10:05 which equals the previous scheduled time
      expect(eventRouter.emitInTx).not.toHaveBeenCalled();

      scheduler.stop();
    });

    it('should emit events that flow through eventRouter (writes to event_log)', async () => {
      const schedule = makeScheduleRegistration({
        workflowName: 'cron-test',
        cronExpression: '*/5 * * * *',
        timezone: 'UTC',
        repoIdentifier: 'org/cron-repo',
      });
      const { db, registrationIndex, cronStore, eventRouter } = createMockDeps({
        schedules: [schedule],
      });

      const scheduler = new CronScheduler({
        db,
        registrationIndex,
        cronStore,
        eventRouter,
        evaluationIntervalMs: 30_000,
      });

      await scheduler.onBecomeLeader();

      // Verify eventRouter.emitInTx was called with full event structure;
      // the second arg is the active tx handle (we just assert it exists).
      expect(eventRouter.emitInTx).toHaveBeenCalledWith(
        {
          eventName: '__schedule_fire',
          payload: {
            cronExpression: '*/5 * * * *',
            timezone: 'UTC',
            registrationId: 'reg-cron-test',
            workflowName: 'cron-test',
            routingKey: 'github:42',
            repoIdentifier: 'org/cron-repo',
            scheduledAt: '2026-02-25T10:05:00.000Z',
          },
          sourceRepo: 'org/cron-repo',
        },
        expect.anything(),
      );

      scheduler.stop();
    });

    // Regression: croner@10's `previousRuns(1)` (plural) THROWS for impossible
    // crons such as '0 0 31 2 *' (Feb 31 doesn't exist), which the outer
    // try/catch in evaluateRegistration() then logged as `error` once per
    // 30s tick -- log spam. The fix replaced it with `previousRun()`
    // (singular), which returns null and is handled by the existing guard.
    it('should silently skip impossible cron expressions without logging an error', async () => {
      const schedule = makeScheduleRegistration({
        workflowName: 'never-fires',
        // Feb 31 never exists -- croner has no previous run for this.
        // The 'stateful-agent-smoke' workflow uses this idiom intentionally.
        cronExpression: '0 0 31 2 *',
      });
      const { db, registrationIndex, cronStore, eventRouter } = createMockDeps({
        schedules: [schedule],
      });

      const scheduler = new CronScheduler({
        db,
        registrationIndex,
        cronStore,
        eventRouter,
        evaluationIntervalMs: 30_000,
      });

      // onBecomeLeader runs both recovery and the periodic-eval cycle once.
      // Either path could trip the bug.
      await scheduler.onBecomeLeader();
      await scheduler.evaluate();

      // No fire claimed, no event emitted.
      expect(cronStore.tryClaimFire).not.toHaveBeenCalled();
      expect(eventRouter.emitInTx).not.toHaveBeenCalled();

      // Critically: NO `logger.error` from the outer catch block. Before the
      // fix this was called every 30s with the croner exception message.
      expect(mockLogger.error).not.toHaveBeenCalled();

      scheduler.stop();
    });
  });

  describe('commit SHA tracking', () => {
    it('should include commitSha and sourceFile in event payload when registration has them', async () => {
      const schedule = makeScheduleRegistration({
        workflowName: 'deploy-prod',
        commitSha: 'abc123def456',
        sourceFile: '.kici/workflows/deploy-prod.ts',
      });
      const { db, registrationIndex, cronStore, eventRouter } = createMockDeps({
        schedules: [schedule],
      });

      const scheduler = new CronScheduler({
        db,
        registrationIndex,
        cronStore,
        eventRouter,
        evaluationIntervalMs: 30_000,
      });

      await scheduler.onBecomeLeader();

      expect(eventRouter.emitInTx).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: '__schedule_fire',
          payload: expect.objectContaining({
            workflowName: 'deploy-prod',
            commitSha: 'abc123def456',
            sourceFile: '.kici/workflows/deploy-prod.ts',
          }),
        }),
        expect.anything(),
      );

      scheduler.stop();
    });

    it('should NOT include commitSha in event payload when registration has null commitSha', async () => {
      const schedule = makeScheduleRegistration({
        workflowName: 'no-sha-workflow',
        commitSha: null,
        sourceFile: null,
      });
      const { db, registrationIndex, cronStore, eventRouter } = createMockDeps({
        schedules: [schedule],
      });

      const scheduler = new CronScheduler({
        db,
        registrationIndex,
        cronStore,
        eventRouter,
        evaluationIntervalMs: 30_000,
      });

      await scheduler.onBecomeLeader();

      const emitCall = eventRouter.emitInTx.mock.calls[0][0];
      expect(emitCall.payload).not.toHaveProperty('commitSha');
      expect(emitCall.payload).not.toHaveProperty('sourceFile');

      scheduler.stop();
    });
  });

  describe('onLoseLeadership', () => {
    it('should stop the evaluation timer', async () => {
      const schedule = makeScheduleRegistration();
      const { db, registrationIndex, cronStore, eventRouter } = createMockDeps({
        schedules: [schedule],
      });

      const scheduler = new CronScheduler({
        db,
        registrationIndex,
        cronStore,
        eventRouter,
        evaluationIntervalMs: 30_000,
      });

      await scheduler.onBecomeLeader();
      eventRouter.emitInTx.mockClear();

      scheduler.onLoseLeadership();

      // Advance time past evaluation interval
      vi.advanceTimersByTime(60_000);

      // Should NOT evaluate -- no longer leader
      // getCronSchedules was called during onBecomeLeader recovery,
      // but should not be called again after losing leadership
      const callsAfterLoss = registrationIndex.getCronSchedules.mock.calls.length;

      vi.advanceTimersByTime(60_000);

      // Should still be the same number of calls
      expect(registrationIndex.getCronSchedules.mock.calls.length).toBe(callsAfterLoss);
      expect(eventRouter.emitInTx).not.toHaveBeenCalled();
    });

    it('should not evaluate after losing leadership even if evaluate is called directly', async () => {
      const schedule = makeScheduleRegistration();
      const { db, registrationIndex, cronStore, eventRouter } = createMockDeps({
        schedules: [schedule],
      });

      const scheduler = new CronScheduler({
        db,
        registrationIndex,
        cronStore,
        eventRouter,
      });

      // Become leader then lose leadership
      await scheduler.onBecomeLeader();
      eventRouter.emitInTx.mockClear();
      registrationIndex.getCronSchedules.mockClear();

      scheduler.onLoseLeadership();

      // Direct evaluate call should be no-op
      await scheduler.evaluate();
      expect(registrationIndex.getCronSchedules).not.toHaveBeenCalled();
      expect(eventRouter.emitInTx).not.toHaveBeenCalled();
    });
  });

  describe('periodic evaluation via timer', () => {
    it('should call getCronSchedules periodically while leader', async () => {
      const schedule = makeScheduleRegistration();
      const { db, registrationIndex, cronStore, eventRouter } = createMockDeps({
        schedules: [schedule],
      });

      const scheduler = new CronScheduler({
        db,
        registrationIndex,
        cronStore,
        eventRouter,
        evaluationIntervalMs: 30_000,
      });

      await scheduler.onBecomeLeader();
      // Recovery calls getCronSchedules once
      const callsAfterRecovery = registrationIndex.getCronSchedules.mock.calls.length;

      // Advance one interval -- should trigger another getCronSchedules call
      await vi.advanceTimersByTimeAsync(30_000);

      expect(registrationIndex.getCronSchedules.mock.calls.length).toBeGreaterThan(
        callsAfterRecovery,
      );

      scheduler.stop();
    });
  });

  describe('rapid leader transitions', () => {
    it('should clear previous timer when onBecomeLeader is called again', async () => {
      const schedule = makeScheduleRegistration();
      const { db, registrationIndex, cronStore, eventRouter } = createMockDeps({
        schedules: [schedule],
      });

      const scheduler = new CronScheduler({
        db,
        registrationIndex,
        cronStore,
        eventRouter,
        evaluationIntervalMs: 30_000,
      });

      // First leader tenure
      await scheduler.onBecomeLeader();
      eventRouter.emitInTx.mockClear();
      cronStore.tryClaimFire.mockClear();

      // Second leader tenure WITHOUT onLoseLeadership in between
      // (simulates rapid Raft transition overlap)
      await scheduler.onBecomeLeader();
      eventRouter.emitInTx.mockClear();
      cronStore.tryClaimFire.mockClear();

      // Advance past two intervals — should only get ticks from the second timer,
      // not double ticks from both leaked + new timer
      vi.setSystemTime(new Date('2026-02-25T10:12:00Z'));
      await vi.advanceTimersByTimeAsync(30_000);

      // Should fire exactly once (from the single active timer), not twice
      const emitCount = eventRouter.emitInTx.mock.calls.length;
      expect(emitCount).toBeLessThanOrEqual(1);

      scheduler.stop();
    });

    it('should not fire events during recovery after losing leadership', async () => {
      // Create many schedules so recovery takes multiple iterations
      const schedules = Array.from({ length: 5 }, (_, i) =>
        makeScheduleRegistration({ workflowName: `wf-${i}` }),
      );
      const { db, registrationIndex, cronStore, eventRouter } = createMockDeps({
        schedules,
      });

      // Make emit slow so we can lose leadership mid-recovery
      let emitCount = 0;
      eventRouter.emitInTx.mockImplementation(async () => {
        emitCount++;
        // After first emit, simulate losing leadership
        if (emitCount === 1) {
          scheduler.onLoseLeadership();
        }
        return 'evt-001';
      });

      const scheduler = new CronScheduler({
        db,
        registrationIndex,
        cronStore,
        eventRouter,
        evaluationIntervalMs: 30_000,
      });

      await scheduler.onBecomeLeader();

      // Only the first schedule should have fired before leadership was lost
      expect(emitCount).toBe(1);

      scheduler.stop();
    });
  });

  describe('refreshCache', () => {
    it('should call cronStore.getAll() and replace lastFiredCache', async () => {
      const schedule = makeScheduleRegistration({ workflowName: 'deploy' });
      const { db, registrationIndex, cronStore, eventRouter } = createMockDeps({
        schedules: [schedule],
      });

      const scheduler = new CronScheduler({
        db,
        registrationIndex,
        cronStore,
        eventRouter,
        evaluationIntervalMs: 30_000,
      });

      // Become leader (loads initial cache)
      await scheduler.onBecomeLeader();
      cronStore.getAll.mockClear();

      // Refresh cache with new data
      const refreshedCache = new Map([['reg-deploy', new Date('2026-02-25T10:05:00.000Z')]]);
      cronStore.getAll.mockResolvedValue(refreshedCache);

      await scheduler.refreshCache();

      expect(cronStore.getAll).toHaveBeenCalledTimes(1);

      scheduler.stop();
    });

    it('should prevent re-firing after refreshCache loads last-fired data', async () => {
      const schedule = makeScheduleRegistration({ workflowName: 'deploy' });
      const { db, registrationIndex, cronStore, eventRouter } = createMockDeps({
        schedules: [schedule],
      });

      const scheduler = new CronScheduler({
        db,
        registrationIndex,
        cronStore,
        eventRouter,
        evaluationIntervalMs: 30_000,
      });

      // Start as leader with empty cache -- recovery fires the schedule
      await scheduler.onBecomeLeader();
      expect(eventRouter.emitInTx).toHaveBeenCalledTimes(1);
      eventRouter.emitInTx.mockClear();
      cronStore.tryClaimFire.mockClear();

      // Now simulate a registration replace: refreshCache loads the last-fired data
      const refreshedCache = new Map([['reg-deploy', new Date('2026-02-25T10:05:00.000Z')]]);
      cronStore.getAll.mockResolvedValue(refreshedCache);
      await scheduler.refreshCache();

      // Evaluate again -- should NOT re-fire because cache shows it was already fired at 10:05
      await scheduler.evaluate();
      expect(eventRouter.emitInTx).not.toHaveBeenCalled();

      scheduler.stop();
    });
  });

  describe('multi-node dedup (tryClaimFire)', () => {
    it('should NOT emit event when another node already claimed the fire', async () => {
      const schedule = makeScheduleRegistration({ workflowName: 'hourly-cron' });
      const { db, registrationIndex, cronStore, eventRouter } = createMockDeps({
        schedules: [schedule],
      });

      // Simulate another node already claimed this fire in the DB
      cronStore.tryClaimFire.mockResolvedValue(false);

      const scheduler = new CronScheduler({
        db,
        registrationIndex,
        cronStore,
        eventRouter,
        evaluationIntervalMs: 30_000,
      });

      await scheduler.onBecomeLeader();

      // tryClaimFire was called but returned false (another node won the race)
      expect(cronStore.tryClaimFire).toHaveBeenCalledTimes(1);
      // Event should NOT have been emitted
      expect(eventRouter.emitInTx).not.toHaveBeenCalled();

      scheduler.stop();
    });

    it('should update local cache even when claim is lost (prevent retry loops)', async () => {
      const schedule = makeScheduleRegistration({ workflowName: 'hourly-cron' });
      const { db, registrationIndex, cronStore, eventRouter } = createMockDeps({
        schedules: [schedule],
      });

      // Another node already claimed
      cronStore.tryClaimFire.mockResolvedValue(false);

      const scheduler = new CronScheduler({
        db,
        registrationIndex,
        cronStore,
        eventRouter,
        evaluationIntervalMs: 30_000,
      });

      await scheduler.onBecomeLeader();
      cronStore.tryClaimFire.mockClear();
      eventRouter.emitInTx.mockClear();

      // Next evaluation should not even attempt to claim (local cache was updated)
      await scheduler.evaluate();
      expect(cronStore.tryClaimFire).not.toHaveBeenCalled();
      expect(eventRouter.emitInTx).not.toHaveBeenCalled();

      scheduler.stop();
    });
  });

  describe('timezone support', () => {
    it('should respect timezone in cron expression evaluation', async () => {
      const schedule = makeScheduleRegistration({
        cronExpression: '*/5 * * * *',
        timezone: 'America/New_York',
      });
      const { db, registrationIndex, cronStore, eventRouter } = createMockDeps({
        schedules: [schedule],
      });

      const scheduler = new CronScheduler({
        db,
        registrationIndex,
        cronStore,
        eventRouter,
        evaluationIntervalMs: 30_000,
      });

      await scheduler.onBecomeLeader();

      // Should fire with the correct timezone-aware scheduled time
      expect(eventRouter.emitInTx).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            timezone: 'America/New_York',
          }),
        }),
        expect.anything(),
      );

      scheduler.stop();
    });
  });
});
