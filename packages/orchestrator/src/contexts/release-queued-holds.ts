/**
 * Release queued concurrency holds as slots free up.
 *
 * A context's concurrency gate returns `queue` when its limit is already met,
 * which holds the job. The stale detector's periodic sweep
 * (`releaseFreedConcurrencyHolds`) drives this module, so a freed slot is reused
 * on the next scan — without it a queued hold sits pending until the (unscoped)
 * expiry sweep marks it expired and its job never runs.
 *
 * The limit is RE-EVALUATED here rather than trusted from the gate decision. A
 * sweep can coincide with other dispatches, and releasing a whole queue on one
 * sweep would put N jobs into a group that admits one.
 */
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { Kysely } from 'kysely';
import { TERMINAL_JOB_STATES } from '@kici-dev/engine';
import type { Database } from '../db/types.js';
import type { HeldRunStore, ReleaseSignal } from './held-runs.js';

const logger = createLogger({ prefix: 'release-queued-holds' });

export interface ReleaseQueuedHoldsArgs {
  db: Kysely<Database>;
  heldRunStore: Pick<HeldRunStore, 'listQueuedHoldsForContext' | 'release'>;
  orgId: string;
  /** The context's concurrency group — `execution_runs.context`. */
  concurrencyGroup: string;
  /** The context's configured limit; `null`/`undefined` means unlimited. */
  concurrencyLimit: number | null | undefined;
  /** Resume a released hold by re-dispatching its job. */
  onJobRelease: (signal: ReleaseSignal) => Promise<void>;
}

/**
 * Count the jobs OCCUPYING a slot in a concurrency group, scoped to one org.
 *
 * A job occupies its slot from the moment it is dispatched until it reaches a
 * terminal status — not merely while its status is `running`. Counting only
 * `running` missed every job that had been dispatched but had not yet reported
 * back, so the sweep read a full group as empty and released queued holds while
 * their slots were still taken. That is a real over-admission, not a cosmetic
 * one: the release path re-checks the limit precisely so the bound holds
 * whenever the sweep happens to run, and an undercount defeats that re-check.
 *
 * The `customer_id` predicate is not optional: a context name shared across
 * tenants would otherwise leak concurrency between them.
 */
export async function countOccupyingJobs(
  db: Kysely<Database>,
  orgId: string,
  concurrencyGroup: string,
): Promise<number> {
  const result = await db
    .selectFrom('execution_jobs')
    .select(db.fn.countAll<number>().as('count'))
    .where('execution_jobs.status', 'not in', [...TERMINAL_JOB_STATES])
    .innerJoin('execution_runs', 'execution_runs.run_id', 'execution_jobs.run_id')
    .where('execution_runs.context', '=', concurrencyGroup)
    .where('execution_runs.customer_id', '=', orgId)
    .executeTakeFirst();
  return Number(result?.count ?? 0);
}

/**
 * Release up to `limit - running` queued holds for a group, oldest first.
 * Returns how many actually resumed.
 */
export async function releaseQueuedHolds(args: ReleaseQueuedHoldsArgs): Promise<number> {
  const { db, heldRunStore, orgId, concurrencyGroup, concurrencyLimit, onJobRelease } = args;
  // An unlimited context never queues, so there is nothing to release and no
  // reason to query for it.
  if (concurrencyLimit === null || concurrencyLimit === undefined) return 0;

  const running = await countOccupyingJobs(db, orgId, concurrencyGroup);
  const free = concurrencyLimit - running;
  if (free <= 0) return 0;

  const queued = await heldRunStore.listQueuedHoldsForContext(orgId, concurrencyGroup);
  if (queued.length === 0) return 0;

  let resumed = 0;
  for (const hold of queued.slice(0, free)) {
    try {
      const signal = await heldRunStore.release(orgId, hold.id);
      await onJobRelease(signal);
      resumed++;
    } catch (err) {
      // One stuck hold must not block the rest of the queue behind it. The row
      // is already flipped to `released`, so this job needs operator attention
      // rather than a silent retry — hence error, not warn.
      logger.error('Failed to resume a released queued hold', {
        holdId: hold.id,
        runId: hold.run_id,
        jobId: hold.job_id,
        concurrencyGroup,
        error: toErrorMessage(err),
      });
    }
  }

  if (resumed > 0) {
    logger.info('Released queued concurrency holds', {
      concurrencyGroup,
      resumed,
      queued: queued.length,
      free,
    });
  }
  return resumed;
}
