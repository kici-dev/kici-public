import { describe, it, expect, vi } from 'vitest';
import { HoldScope, TriggerSource } from '@kici-dev/engine';
import { ExecutionJobStatus } from '@kici-dev/engine';
import { releaseQueuedHolds, countOccupyingJobs } from './release-queued-holds.js';

/** A held_runs row as `listQueuedHoldsForContext` returns it. */
const row = (id: string, createdAt: string) => ({
  id,
  run_id: `run-${id}`,
  job_id: `job-${id}`,
  hold_scope: HoldScope.enum.job,
  trigger_source: TriggerSource.enum.context,
  step_index: null,
  created_at: new Date(createdAt),
});

/** A store whose queued list is fixed and whose release echoes a signal. */
function store(queued: ReturnType<typeof row>[]) {
  return {
    listQueuedHoldsForContext: vi.fn().mockResolvedValue(queued),
    release: vi.fn(async (_org: string, holdId: string) => {
      const r = queued.find((q) => q.id === holdId)!;
      return {
        holdId: r.id,
        runId: r.run_id,
        jobId: r.job_id,
        scope: HoldScope.enum.job,
        stepIndex: null,
        triggerSource: TriggerSource.enum.context,
      };
    }),
  };
}

/** A db whose running-job count is fixed. */
const db = (running: number) =>
  ({
    fn: { countAll: () => ({ as: (a: string) => a }) },
    selectFrom: () => ({
      select: function (this: unknown) {
        return this;
      },
      where: function (this: unknown) {
        return this;
      },
      innerJoin: function (this: unknown) {
        return this;
      },
      executeTakeFirst: async () => ({ count: running }),
    }),
  }) as never;

describe('releaseQueuedHolds', () => {
  it('releases only as many holds as there are free slots, oldest first', async () => {
    // limit 3, two running → exactly one free slot. Releasing the whole queue
    // here would put four jobs into a group that allows three.
    const onJobRelease = vi.fn().mockResolvedValue(undefined);
    const s = store([row('old', '2026-01-01'), row('new', '2026-01-02')]);

    const released = await releaseQueuedHolds({
      db: db(2),
      heldRunStore: s as never,
      orgId: 'org-1',
      concurrencyGroup: 'prod',
      concurrencyLimit: 3,
      onJobRelease,
    });

    expect(released).toBe(1);
    expect(s.release).toHaveBeenCalledTimes(1);
    expect(s.release.mock.calls[0][1]).toBe('old');
    expect(onJobRelease).toHaveBeenCalledTimes(1);
    expect(onJobRelease.mock.calls[0][0]).toMatchObject({ jobId: 'job-old' });
  });

  it('releases nothing when the limit is already met', async () => {
    const onJobRelease = vi.fn();
    const s = store([row('old', '2026-01-01')]);

    const released = await releaseQueuedHolds({
      db: db(3),
      heldRunStore: s as never,
      orgId: 'org-1',
      concurrencyGroup: 'prod',
      concurrencyLimit: 3,
      onJobRelease,
    });

    expect(released).toBe(0);
    expect(s.release).not.toHaveBeenCalled();
    expect(onJobRelease).not.toHaveBeenCalled();
  });

  it('releases the whole queue when it is smaller than the free slots', async () => {
    const onJobRelease = vi.fn().mockResolvedValue(undefined);
    const s = store([row('a', '2026-01-01'), row('b', '2026-01-02')]);

    const released = await releaseQueuedHolds({
      db: db(0),
      heldRunStore: s as never,
      orgId: 'org-1',
      concurrencyGroup: 'prod',
      concurrencyLimit: 10,
      onJobRelease,
    });

    expect(released).toBe(2);
  });

  it('keeps going when one release throws, and reports the successes', async () => {
    // A single stuck hold must not block the rest of the queue behind it.
    const onJobRelease = vi
      .fn()
      .mockRejectedValueOnce(new Error('dispatch exploded'))
      .mockResolvedValue(undefined);
    const s = store([row('a', '2026-01-01'), row('b', '2026-01-02')]);

    const released = await releaseQueuedHolds({
      db: db(0),
      heldRunStore: s as never,
      orgId: 'org-1',
      concurrencyGroup: 'prod',
      concurrencyLimit: 10,
      onJobRelease,
    });

    expect(released).toBe(1);
    expect(onJobRelease).toHaveBeenCalledTimes(2);
  });

  it('does nothing for an unlimited context', async () => {
    // No limit means the gate never queued anything, so there is nothing to
    // release and no reason to query.
    const onJobRelease = vi.fn();
    const s = store([]);

    const released = await releaseQueuedHolds({
      db: db(0),
      heldRunStore: s as never,
      orgId: 'org-1',
      concurrencyGroup: 'prod',
      concurrencyLimit: null,
      onJobRelease,
    });

    expect(released).toBe(0);
    expect(s.listQueuedHoldsForContext).not.toHaveBeenCalled();
  });
});

describe('countOccupyingJobs', () => {
  /** A db that records every `where()` predicate it is handed. */
  const recordingDb = (count: number, calls: unknown[][]) =>
    ({
      fn: { countAll: () => ({ as: (a: string) => a }) },
      selectFrom: () => ({
        select: function (this: unknown) {
          return this;
        },
        where: function (this: unknown, ...args: unknown[]) {
          calls.push(args);
          return this;
        },
        innerJoin: function (this: unknown) {
          return this;
        },
        executeTakeFirst: async () => ({ count }),
      }),
    }) as never;

  it('counts a dispatched job that has not started yet, not only `running` ones', async () => {
    // The sweep released queued holds while their slots were still taken,
    // because a job dispatched in this pass sits at `pending` until the agent
    // reports back — invisible to a `status = 'running'` predicate. A job holds
    // its slot from dispatch until it terminalizes.
    const calls: unknown[][] = [];
    await countOccupyingJobs(recordingDb(0, calls), 'org-1', 'prod');

    const status = calls.find((c) => c[0] === 'execution_jobs.status');
    expect(status, 'the count must filter on job status').toBeDefined();
    expect(status![1]).toBe('not in');

    const excluded = status![2] as string[];
    // Non-terminal statuses occupy a slot, so none of them may be excluded.
    for (const occupying of [
      ExecutionJobStatus.enum.pending,
      ExecutionJobStatus.enum.queued,
      ExecutionJobStatus.enum.running,
      ExecutionJobStatus.enum.recovering,
      ExecutionJobStatus.enum.cancelling,
    ]) {
      expect(excluded, `${occupying} still occupies its slot`).not.toContain(occupying);
    }
    // A terminal job has given its slot back.
    expect(excluded).toContain(ExecutionJobStatus.enum.success);
    expect(excluded).toContain(ExecutionJobStatus.enum.cancelled);
  });

  it('scopes the count to one org so a shared context name cannot leak concurrency', async () => {
    const calls: unknown[][] = [];
    await countOccupyingJobs(recordingDb(0, calls), 'org-1', 'prod');
    expect(calls).toContainEqual(['execution_runs.customer_id', '=', 'org-1']);
    expect(calls).toContainEqual(['execution_runs.context', '=', 'prod']);
  });

  /**
   * Apply the predicates the query actually built to a hand-written row set.
   *
   * The rows below are authored here and the predicates come from the code, so
   * this pins their agreement rather than restating the implementation: drop a
   * `where()` from `countOccupyingJobs` and the surviving rows change.
   */
  function rowsPassing(
    rows: Array<{ job_id: string; status: string }>,
    calls: unknown[][],
  ): Array<{ job_id: string; status: string }> {
    const jobPredicates = calls.filter((c) => String(c[0]).startsWith('execution_jobs.'));
    return rows.filter((row) =>
      jobPredicates.every(([column, op, value]) => {
        const cell = row[String(column).replace('execution_jobs.', '') as 'job_id' | 'status'];
        if (op === 'not in') return !(value as string[]).includes(cell);
        if (op === 'not like') return !cell.startsWith(String(value).replace(/%$/, ''));
        if (op === '=') return cell === value;
        throw new Error(`unhandled operator in countOccupyingJobs: ${String(op)}`);
      }),
    );
  }

  it('excludes the placeholder row of a job that has reached no agent', async () => {
    // A held / needs-gated / wave-gated job is registered under a
    // `needs-pending-` id at status `pending` so the run stays open for it — it
    // occupies no slot. Counting it made a queued hold count against the very
    // limit that gates its release: one held job in a limit-1 group read as
    // `free = 1 - 1 = 0` and was never released at all.
    const calls: unknown[][] = [];
    await countOccupyingJobs(recordingDb(0, calls), 'org-1', 'prod');

    const rows = [
      { job_id: 'real-dispatched', status: ExecutionJobStatus.enum.pending },
      { job_id: 'real-running', status: ExecutionJobStatus.enum.running },
      { job_id: 'needs-pending-deploy (c)-abc', status: ExecutionJobStatus.enum.pending },
      { job_id: 'real-finished', status: ExecutionJobStatus.enum.success },
    ];

    expect(rowsPassing(rows, calls).map((r) => r.job_id)).toEqual([
      'real-dispatched',
      'real-running',
    ]);

    // The status predicate alone does NOT do this: the placeholder is `pending`,
    // so dropping the `job_id` predicate counts it. Driving the exclusion
    // through the predicate set proves it is load-bearing without any of the
    // assertions above having to restate the query.
    const statusOnly = calls.filter((c) => c[0] === 'execution_jobs.status');
    expect(rowsPassing(rows, statusOnly).map((r) => r.job_id)).toContain(
      'needs-pending-deploy (c)-abc',
    );
  });
});
