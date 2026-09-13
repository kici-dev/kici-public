import { describe, it, expect, vi } from 'vitest';
import {
  readNeedsVerdict,
  NEEDS_READ_ATTEMPTS,
  dispatchReadyJob,
  storePendingJobContext,
  consumePendingJobContext,
} from './processor.js';

/** The `needs-pending-` placeholder id a job waiting on the needs gate is tracked under. */
const SYNTHETIC_ID = 'needs-pending-deploy-0000';

/** A db whose needs-edge read throws `failures` times, then returns no edges. */
function throwingNeedsDb(failures: number, calls: { n: number }) {
  return {
    selectFrom: () => ({
      select: function (this: unknown) {
        return this;
      },
      where: function (this: unknown) {
        return this;
      },
      execute: async () => {
        calls.n++;
        if (calls.n <= failures) throw new Error('connection terminated');
        return [];
      },
    }),
  } as never;
}

describe('readNeedsVerdict', () => {
  it('answers unsatisfied rather than dispatchable when the read never succeeds', async () => {
    const calls = { n: 0 };
    const verdict = await readNeedsVerdict(throwingNeedsDb(99, calls), 'run-x', 'deploy', {
      attempts: 2,
      retryBaseMs: 0,
    });
    // Fail CLOSED: an unreadable verdict must never be read as "go ahead".
    expect(verdict.satisfied).toBe(false);
    expect(calls.n).toBe(2);
  });

  it('returns the real verdict when a transient failure clears within the retries', async () => {
    const calls = { n: 0 };
    const verdict = await readNeedsVerdict(throwingNeedsDb(1, calls), 'run-y', 'deploy', {
      attempts: 3,
      retryBaseMs: 0,
    });
    expect(verdict).toEqual({ satisfied: true, action: 'dispatch' });
    expect(calls.n).toBe(2);
  });

  it('budgets enough attempts to ride out a blip', () => {
    // One attempt would turn every transient blip into a stalled job.
    expect(NEEDS_READ_ATTEMPTS).toBeGreaterThanOrEqual(3);
  });
});

/**
 * A db that reports one needs edge whose upstream sits at `upstreamStatus`,
 * and reports no pending approval hold (so `hasPendingHold` lets us through).
 *
 * `run_on` admits only `success`, so a `failed` upstream yields the skip branch
 * and a `running` upstream yields the not-yet-satisfied branch.
 */
function needsDb(upstreamStatus: string) {
  return {
    selectFrom: (table: string) => ({
      select: function (this: unknown) {
        return this;
      },
      where: function (this: unknown) {
        return this;
      },
      // hasPendingHold reads held_runs via executeTakeFirst -> undefined = no hold.
      executeTakeFirst: async () => undefined,
      execute: async () =>
        table === 'execution_job_needs'
          ? [{ upstream_name: 'build', run_on: JSON.stringify(['success']) }]
          : [{ job_name: 'build', status: upstreamStatus }],
    }),
    deleteFrom: () => ({
      where: function (this: unknown) {
        return this;
      },
      returning: function (this: unknown) {
        return this;
      },
      execute: async () => [],
    }),
  } as never;
}

describe('dispatchReadyJob needs guard', () => {
  it('does not dispatch while the upstream is still running, and keeps the context', async () => {
    const dispatch = vi.fn();
    await storePendingJobContext(undefined, 'run-pending', 'deploy', {
      jobInput: { runId: 'run-pending', jobName: 'deploy', jobConfig: {} } as never,
      runsOnLabels: ['default'],
    });

    await dispatchReadyJob(
      'run-pending',
      'deploy',
      { dispatch } as never,
      undefined,
      undefined,
      needsDb('running'),
    );

    expect(dispatch).not.toHaveBeenCalled();
    // Non-vacuous by construction: the context surviving is only possible if the
    // guard returned BEFORE consumePendingJobContext.
    expect(await consumePendingJobContext(undefined, 'run-pending', 'deploy')).toBeDefined();
  });

  it('skips the job instead of dispatching it when the upstream failed', async () => {
    const dispatch = vi.fn();
    const onJobStatus = vi.fn().mockResolvedValue(undefined);
    await storePendingJobContext(undefined, 'run-failed', 'deploy', {
      jobInput: { runId: 'run-failed', jobName: 'deploy', jobConfig: {} } as never,
      runsOnLabels: ['default'],
    });

    await dispatchReadyJob(
      'run-failed',
      'deploy',
      { dispatch } as never,
      {
        onJobStatus,
        findSyntheticJobId: vi.fn().mockResolvedValue(SYNTHETIC_ID),
        addJobsToRun: vi.fn(),
      } as never,
      undefined,
      needsDb('failed'),
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(onJobStatus).toHaveBeenCalledTimes(1);
    // `onJobStatus` keys on the execution_jobs job_id. A job NAME here matches
    // no tracked row: the upsert would INSERT a second row, the scheduler hook
    // would never run, and the real placeholder would stay pending forever.
    expect(onJobStatus.mock.calls[0][1]).toBe(SYNTHETIC_ID);
    expect(onJobStatus.mock.calls[0][2]).toBe('skipped');
    // The skip consumes the context: the scheduler will never fire ready again,
    // so leaving it would strand the row until the expiry sweep.
    expect(await consumePendingJobContext(undefined, 'run-failed', 'deploy')).toBeUndefined();
  });

  it('keeps the context when the job to skip has no tracked row to terminalize', async () => {
    const onJobStatus = vi.fn().mockResolvedValue(undefined);
    await storePendingJobContext(undefined, 'run-untracked', 'deploy', {
      jobInput: { runId: 'run-untracked', jobName: 'deploy', jobConfig: {} } as never,
      runsOnLabels: ['default'],
    });

    await dispatchReadyJob(
      'run-untracked',
      'deploy',
      { dispatch: vi.fn() } as never,
      // No placeholder resolves, so the job is not waiting on a gate.
      {
        onJobStatus,
        findSyntheticJobId: vi.fn().mockResolvedValue(undefined),
        addJobsToRun: vi.fn(),
      } as never,
      undefined,
      needsDb('failed'),
    );

    expect(onJobStatus).not.toHaveBeenCalled();
    // Non-vacuous by construction: the context survives only if the guard
    // returned BEFORE consumePendingJobContext. Consuming it with nothing to
    // terminalize would delete the last resume path.
    expect(await consumePendingJobContext(undefined, 'run-untracked', 'deploy')).toBeDefined();
  });

  it('leaves an already-dispatched job alone rather than resolving it by name', async () => {
    // The one state where `findSyntheticJobId` misses AND an `execution_jobs`
    // row for (run_id, job_name) exists is a job whose placeholder was already
    // swapped for a real dispatched id — a job that already ran. Resolving it
    // by name would let this gate overwrite a running or `success` row with
    // `skipped`, because the tracker's upsert carries no terminal-status guard.
    // The stub therefore reports a real row for every by-name read; the gate
    // must still terminalize nothing.
    const onJobStatus = vi.fn().mockResolvedValue(undefined);
    const dispatchedRowDb = {
      selectFrom: (table: string) => ({
        select: function (this: unknown) {
          return this;
        },
        where: function (this: unknown) {
          return this;
        },
        executeTakeFirst: async () =>
          // No approval hold; but a real, already-dispatched execution_jobs row.
          table === 'execution_jobs' ? { job_id: 'real-dispatched-job-id' } : undefined,
        execute: async () =>
          table === 'execution_job_needs'
            ? [{ upstream_name: 'build', run_on: JSON.stringify(['success']) }]
            : [{ job_name: 'build', status: 'failed' }],
      }),
      deleteFrom: () => ({
        where: function (this: unknown) {
          return this;
        },
        returning: function (this: unknown) {
          return this;
        },
        execute: async () => [],
      }),
    } as never;

    await storePendingJobContext(undefined, 'run-already', 'deploy', {
      jobInput: { runId: 'run-already', jobName: 'deploy', jobConfig: {} } as never,
      runsOnLabels: ['default'],
    });

    await dispatchReadyJob(
      'run-already',
      'deploy',
      { dispatch: vi.fn() } as never,
      {
        onJobStatus,
        findSyntheticJobId: vi.fn().mockResolvedValue(undefined),
        addJobsToRun: vi.fn(),
      } as never,
      undefined,
      dispatchedRowDb,
    );

    // Never terminalized, and in particular never with the real row's id.
    expect(onJobStatus).not.toHaveBeenCalled();
    expect(await consumePendingJobContext(undefined, 'run-already', 'deploy')).toBeDefined();
  });

  it('dispatches normally when the upstream succeeded', async () => {
    const dispatch = vi
      .fn()
      .mockResolvedValue({ status: 'dispatched', agentId: 'a1', jobId: 'j1' });
    await storePendingJobContext(undefined, 'run-ok', 'deploy', {
      jobInput: { runId: 'run-ok', jobName: 'deploy', jobConfig: {} } as never,
      runsOnLabels: ['default'],
    });

    await dispatchReadyJob(
      'run-ok',
      'deploy',
      { dispatch } as never,
      undefined,
      undefined,
      needsDb('success'),
    );

    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('skip propagation', () => {
  it('routes the skip through onJobStatus, which is what drives evaluateDownstreams', async () => {
    // The propagation itself lives in ExecutionTracker.runSchedulerHook, which
    // runs only when onJobStatus is given a TERMINAL status AND a job_id that
    // resolves to a tracked job. Both are this guard's responsibility, so both
    // are asserted here.
    const onJobStatus = vi.fn().mockResolvedValue(undefined);
    await storePendingJobContext(undefined, 'run-prop', 'deploy', {
      jobInput: { runId: 'run-prop', jobName: 'deploy', jobConfig: {} } as never,
      runsOnLabels: ['default'],
    });

    await dispatchReadyJob(
      'run-prop',
      'deploy',
      { dispatch: vi.fn() } as never,
      {
        onJobStatus,
        findSyntheticJobId: vi.fn().mockResolvedValue(SYNTHETIC_ID),
        addJobsToRun: vi.fn(),
      } as never,
      undefined,
      needsDb('failed'),
    );

    const [, jobId, state, timestamp, , data] = onJobStatus.mock.calls[0];
    expect(jobId).toBe(SYNTHETIC_ID);
    expect(state).toBe('skipped');
    expect(typeof timestamp).toBe('number');
    // `error` is the key the tracker persists to `error_message`; a `reason`
    // key would be dropped and the skipped job would carry no cause.
    expect(String(data.error)).toContain('upstream_unmet');
  });
});
