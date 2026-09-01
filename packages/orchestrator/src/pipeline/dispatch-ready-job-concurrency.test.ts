import { describe, it, expect, vi } from 'vitest';
import { ConcurrencyStrategy, DEFAULT_HOLD_EXPIRY_SECONDS, HoldType } from '@kici-dev/engine';
import {
  resolveRunConcurrency,
  dispatchReadyJob,
  storePendingJobContext,
  consumePendingJobContext,
} from './processor.js';

/** A db whose `execution_runs` lookup returns `run`. */
function runDb(run: { context: string | null; customer_id: string | null } | undefined) {
  return {
    selectFrom: () => ({
      select: function (this: unknown) {
        return this;
      },
      where: function (this: unknown) {
        return this;
      },
      executeTakeFirst: async () => run,
    }),
  } as never;
}

describe('resolveRunConcurrency', () => {
  it('returns null for a run with no bound context, without consulting the store', async () => {
    const matchContext = vi.fn();
    const resolved = await resolveRunConcurrency(
      runDb({ context: null, customer_id: 'org-1' }),
      matchContext,
      'run-1',
    );
    expect(resolved).toBeNull();
    expect(matchContext).not.toHaveBeenCalled();
  });

  it('returns null when the context no longer exists', async () => {
    const resolved = await resolveRunConcurrency(
      runDb({ context: 'prod', customer_id: 'org-1' }),
      vi.fn().mockResolvedValue(null),
      'run-1',
    );
    expect(resolved).toBeNull();
  });

  it('returns the org, group, limit, strategy and hold window for a bound context', async () => {
    const resolved = await resolveRunConcurrency(
      runDb({ context: 'prod', customer_id: 'org-1' }),
      vi.fn().mockResolvedValue({
        id: 'ctx-1',
        concurrency_limit: 2,
        concurrency_strategy: 'cancel-pending',
        hold_expiry_seconds: 300,
      }),
      'run-1',
    );
    expect(resolved).toEqual({
      orgId: 'org-1',
      group: 'prod',
      contextId: 'ctx-1',
      limit: 2,
      strategy: ConcurrencyStrategy.enum['cancel-pending'],
      holdExpirySeconds: 300,
    });
  });

  it('resolves an unset strategy to the default rather than leaving it undefined', async () => {
    const resolved = await resolveRunConcurrency(
      runDb({ context: 'prod', customer_id: 'org-1' }),
      vi.fn().mockResolvedValue({ id: 'ctx-1', concurrency_limit: 2, concurrency_strategy: null }),
      'run-1',
    );
    expect(resolved?.strategy).toBe(ConcurrencyStrategy.enum.queue);
  });

  it('resolves an unset hold window to the default rather than leaving it undefined', async () => {
    const resolved = await resolveRunConcurrency(
      runDb({ context: 'prod', customer_id: 'org-1' }),
      vi.fn().mockResolvedValue({ id: 'ctx-1', concurrency_limit: 2, hold_expiry_seconds: null }),
      'run-1',
    );
    expect(resolved?.holdExpirySeconds).toBe(DEFAULT_HOLD_EXPIRY_SECONDS);
  });
});

/**
 * A db for the full `dispatchReadyJob` path: no approval hold, no needs edges,
 * a run bound to context `prod`, and `running` jobs currently in the group.
 *
 * `onCountRunning` fires when the `execution_jobs` running-count query actually
 * executes, so a test can assert the gate short-circuited before reaching it.
 */
function gateDb(running: number, context: string | null = 'prod', onCountRunning?: () => void) {
  return {
    fn: { countAll: () => ({ as: (a: string) => a }) },
    selectFrom: (table: string) => ({
      select: function (this: unknown) {
        return this;
      },
      where: function (this: unknown) {
        return this;
      },
      innerJoin: function (this: unknown) {
        return this;
      },
      executeTakeFirst: async () => {
        if (table === 'execution_runs') return { context, customer_id: 'org-1' };
        if (table === 'execution_jobs') {
          onCountRunning?.();
          return { count: running };
        }
        return undefined; // held_runs -> no pending approval hold
      },
      execute: async () => [], // execution_job_needs -> no needs edges
    }),
    deleteFrom: () => ({
      where: function (this: unknown) {
        return this;
      },
      execute: async () => undefined,
      returningAll: function (this: unknown) {
        return this;
      },
      executeTakeFirst: async () => undefined,
    }),
  } as never;
}

const limitedContext = { id: 'ctx-1', concurrency_limit: 2, concurrency_strategy: null };

/** A hold window well below {@link DEFAULT_HOLD_EXPIRY_SECONDS}, seconds. */
const SHORT_HOLD_SECONDS = 300;

/** A dispatcher whose `dispatch` reports the job as handed to an agent. */
function okDispatcher() {
  return vi.fn().mockResolvedValue({ status: 'dispatched', agentId: 'a1', jobId: 'j1' });
}

async function storeCtx(runId: string, jobName: string) {
  await storePendingJobContext(undefined, runId, jobName, {
    jobInput: { runId, jobName, jobConfig: {} } as never,
    runsOnLabels: ['default'],
  });
}

describe('dispatchReadyJob concurrency re-gate', () => {
  it('dispatches when the group is below its limit', async () => {
    const dispatch = okDispatcher();
    await storeCtx('run-under', 'deploy');

    await dispatchReadyJob(
      'run-under',
      'deploy',
      { dispatch } as never,
      undefined,
      undefined,
      gateDb(1),
      undefined,
      {
        matchContext: vi.fn().mockResolvedValue(limitedContext),
        heldRunStore: { create: vi.fn() },
      },
    );

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('re-holds instead of dispatching when the group is at its limit', async () => {
    const dispatch = vi.fn();
    const create = vi.fn().mockResolvedValue({ id: 'hold-1' });
    await storeCtx('run-at-limit', 'deploy');

    await dispatchReadyJob(
      'run-at-limit',
      'deploy',
      { dispatch } as never,
      undefined,
      undefined,
      gateDb(2),
      undefined,
      { matchContext: vi.fn().mockResolvedValue(limitedContext), heldRunStore: { create } },
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toBe('org-1');
    expect(create.mock.calls[0]![1]).toMatchObject({
      runId: 'run-at-limit',
      jobId: 'deploy',
      contextId: 'ctx-1',
      holdType: HoldType.enum.concurrency,
    });
    // Non-vacuous by construction: the context surviving proves the re-gate
    // returned BEFORE consumePendingJobContext, so the release path can resume it.
    expect(await consumePendingJobContext(undefined, 'run-at-limit', 'deploy')).toBeDefined();
  });

  it("expires the re-hold on the context's own configured hold window", async () => {
    const create = vi.fn().mockResolvedValue({ id: 'hold-1' });
    await storeCtx('run-short-window', 'deploy');

    const before = Date.now();
    await dispatchReadyJob(
      'run-short-window',
      'deploy',
      { dispatch: vi.fn() } as never,
      undefined,
      undefined,
      gateDb(2),
      undefined,
      {
        matchContext: vi
          .fn()
          .mockResolvedValue({ ...limitedContext, hold_expiry_seconds: SHORT_HOLD_SECONDS }),
        heldRunStore: { create },
      },
    );
    const after = Date.now();

    // Bounded by the configured window on both sides, and the window is an order
    // of magnitude below `DEFAULT_HOLD_EXPIRY_SECONDS` — an implementation that
    // ignored the column and fell back to the default cannot land in this range.
    const expiresAt = (create.mock.calls[0]![1] as { expiresAt: Date }).expiresAt.getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + SHORT_HOLD_SECONDS * 1000);
    expect(expiresAt).toBeLessThanOrEqual(after + SHORT_HOLD_SECONDS * 1000);
  });

  it('is a no-op when the run has no bound context', async () => {
    const dispatch = okDispatcher();
    const matchContext = vi.fn();
    await storeCtx('run-free', 'deploy');

    await dispatchReadyJob(
      'run-free',
      'deploy',
      { dispatch } as never,
      undefined,
      undefined,
      gateDb(99, null),
      undefined,
      { matchContext, heldRunStore: { create: vi.fn() } },
    );

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(matchContext).not.toHaveBeenCalled();
  });

  it('is a no-op when no gate deps are supplied', async () => {
    const dispatch = okDispatcher();
    await storeCtx('run-nodeps', 'deploy');

    await dispatchReadyJob(
      'run-nodeps',
      'deploy',
      { dispatch } as never,
      undefined,
      undefined,
      gateDb(99),
    );

    // No stores to read, so the call site keeps its prior behaviour rather than
    // failing closed and stranding every job on a deployment with no contexts.
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('treats a null limit as unlimited and never queries the running count', async () => {
    const dispatch = okDispatcher();
    const create = vi.fn();
    // The count query is the assertion, not scenery: it is what the gate must
    // not reach on an unlimited context, and `gateDb(99)` would otherwise
    // report a group far over any limit.
    const countRunning = vi.fn();
    await storeCtx('run-unlimited', 'deploy');

    await dispatchReadyJob(
      'run-unlimited',
      'deploy',
      { dispatch } as never,
      undefined,
      undefined,
      gateDb(99, 'prod', countRunning),
      undefined,
      {
        matchContext: vi.fn().mockResolvedValue({ id: 'ctx-1', concurrency_limit: null }),
        heldRunStore: { create },
      },
    );

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(countRunning).not.toHaveBeenCalled();
  });

  it('queries the running count when a limit IS set', async () => {
    // The positive control for the assertion above: same db, same call shape,
    // a limit present — so `countRunning` not firing there can only mean the
    // gate short-circuited, never that the spy is unwired.
    const countRunning = vi.fn();
    await storeCtx('run-limited-control', 'deploy');

    await dispatchReadyJob(
      'run-limited-control',
      'deploy',
      { dispatch: vi.fn() } as never,
      undefined,
      undefined,
      gateDb(99, 'prod', countRunning),
      undefined,
      {
        matchContext: vi.fn().mockResolvedValue(limitedContext),
        heldRunStore: { create: vi.fn().mockResolvedValue({ id: 'hold-1' }) },
      },
    );

    expect(countRunning).toHaveBeenCalledTimes(1);
  });
});

describe('dispatchReadyJob re-gate exemptions and audit', () => {
  it('does not re-gate an invoke gate, which occupies no slot', async () => {
    // An invoke gate summons the source repo's subscribers instead of reaching
    // an agent, so it never becomes a `running` row the count would see. Gating
    // it queues a cross-repo summon behind jobs it does not compete with.
    const matchContext = vi.fn();
    const create = vi.fn();
    const countRunning = vi.fn();
    await storePendingJobContext(undefined, 'run-invoke', 'summon', {
      jobInput: { runId: 'run-invoke', jobName: 'summon', jobConfig: {} } as never,
      runsOnLabels: [],
      invoke: { event: 'e2e-summon' } as never,
    });

    await dispatchReadyJob(
      'run-invoke',
      'summon',
      { dispatch: vi.fn() } as never,
      undefined,
      undefined,
      // A group far over its limit — the only reason no hold is minted is the
      // exemption, not the arithmetic.
      gateDb(99, 'prod', countRunning),
      undefined,
      { matchContext, heldRunStore: { create } },
    );

    expect(create, 'an invoke gate must not be re-held on concurrency').not.toHaveBeenCalled();
    expect(
      matchContext,
      'the re-gate must short-circuit before resolving the context',
    ).not.toHaveBeenCalled();
    expect(countRunning).not.toHaveBeenCalled();
  });

  it('audits each re-hold with a held_run.request row naming the created hold', async () => {
    // The dispatch-pass path writes one `held_run.request` row per hold it
    // mints; a hold that shows up in the approval queue with no trail saying it
    // was raised is a gap whichever gate raised it.
    const record = vi.fn();
    await storeCtx('run-audited', 'deploy');

    await dispatchReadyJob(
      'run-audited',
      'deploy',
      { dispatch: vi.fn() } as never,
      undefined,
      undefined,
      gateDb(2),
      undefined,
      {
        matchContext: vi.fn().mockResolvedValue(limitedContext),
        heldRunStore: { create: vi.fn().mockResolvedValue({ id: 'hold-audited' }) },
        accessLogWriter: { record },
        routingKey: 'rk-1',
      },
    );

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![0]).toMatchObject({
      orgId: 'org-1',
      routingKey: 'rk-1',
      action: 'held_run.request',
      target: { type: 'held_run', id: 'hold-audited' },
      actor: { type: 'system', component: 'dispatcher' },
      meta: { runId: 'run-audited', jobId: 'deploy', holdType: HoldType.enum.concurrency },
    });
  });

  it('re-holds without a writer rather than failing the gate', async () => {
    // The dispatch-pass path's own `accessLogWriter?.record` degrades the same
    // way: a call site with no writer still gates.
    const create = vi.fn().mockResolvedValue({ id: 'hold-unaudited' });
    const dispatch = vi.fn();
    await storeCtx('run-unaudited', 'deploy');

    await dispatchReadyJob(
      'run-unaudited',
      'deploy',
      { dispatch } as never,
      undefined,
      undefined,
      gateDb(2),
      undefined,
      { matchContext: vi.fn().mockResolvedValue(limitedContext), heldRunStore: { create } },
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
