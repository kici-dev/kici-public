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
import { NEEDS_PENDING_JOB_ID_LIKE } from '../db/synthetic-job-ids.js';
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

/** Jobs of one run the caller already accounts for itself. */
export interface OccupyingJobExclusion {
  /** The run the excluded names belong to. */
  runId: string;
  /** `execution_jobs.job_name` values to leave out of the count. */
  jobNames: readonly string[];
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
 * A PLACEHOLDER row is excluded, and that exclusion is what keeps the count
 * from deadlocking the queue it gates. A job the dispatch pass held back — on a
 * `needs` edge, a rolling-wave slot, an invoke-gate summon, or a protection-rule
 * hold — is registered under a `needs-pending-` id at status `pending` so the
 * run stays open for it. It has reached no agent, so it occupies nothing; and
 * counting it meant a queued hold counted against the very limit that gates its
 * own release. One held job in a limit-1 group then read as `free = 1 - 1 = 0`
 * and was never released at all, and the hold sat until the expiry sweep failed
 * it. Its real row, with the dispatcher's own job id, replaces the placeholder
 * the moment it dispatches — so the slot is counted from exactly then.
 *
 * The `customer_id` predicate is not optional: a context name shared across
 * tenants would otherwise leak concurrency between them.
 *
 * `exclude` lets a caller that carries its own in-memory reservation for some
 * of these jobs keep the two terms disjoint. The dispatch gate is the one such
 * caller; the release sweep passes nothing and counts everything.
 */
export async function countOccupyingJobs(
  db: Kysely<Database>,
  orgId: string,
  concurrencyGroup: string,
  exclude?: OccupyingJobExclusion,
): Promise<number> {
  let query = db
    .selectFrom('execution_jobs')
    .select(db.fn.countAll<number>().as('count'))
    .where('execution_jobs.status', 'not in', [...TERMINAL_JOB_STATES])
    .where('execution_jobs.job_id', 'not like', NEEDS_PENDING_JOB_ID_LIKE)
    .innerJoin('execution_runs', 'execution_runs.run_id', 'execution_jobs.run_id')
    .where('execution_runs.context', '=', concurrencyGroup)
    .where('execution_runs.customer_id', '=', orgId);
  if (exclude && exclude.jobNames.length > 0) {
    // `NOT (that run AND one of those names)`. The run qualifier is not
    // optional: a job name is unique within a run and nowhere else, so an
    // unqualified exclusion would drop ANOTHER run's `deploy` from the count —
    // precisely the job the limit exists to see.
    const { runId, jobNames } = exclude;
    query = query.where((eb) =>
      eb.not(
        eb.and([
          eb('execution_jobs.run_id', '=', runId),
          eb('execution_jobs.job_name', 'in', [...jobNames]),
        ]),
      ),
    );
  }
  const result = await query.executeTakeFirst();
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
