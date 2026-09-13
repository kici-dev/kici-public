import type { Kysely } from 'kysely';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { ExecutionRunStatus } from '@kici-dev/engine';
import type { Database } from '../db/types.js';

const logger = createLogger({ prefix: 'cancel-sweep' });

/** How many stuck runs one tick re-drives, so a large backlog cannot stall the sweep. */
const MAX_PER_TICK = 20;

export interface SweepStuckCancellingDeps {
  db: Kysely<Database>;
  /** The canonical cancel path, bound to this orchestrator's deps. */
  cancelRun: (runId: string, reason: string) => Promise<unknown>;
  /**
   * How long a run may sit in `cancelling` before it is re-driven. Twice the
   * recovery grace period: long enough that a graceful agent teardown finishes
   * on its own, short enough that a dropped cancel does not sit for an hour.
   */
  stuckAfterMs: number;
}

/**
 * Re-drive the cancel for runs left in `cancelling`.
 *
 * A cancel reaches its target over the peer channel, and a peer blip drops it.
 * The run then sits in `cancelling` with its jobs still executing, and nothing
 * retries: the workflow-deadline detector re-scans `cancelling` runs, but only
 * ones that HAVE a workflow timeout, so a run without one waits forever. This
 * extends the same coverage to every run.
 *
 * Leader-gated by its caller, and idempotent by construction — re-driving a
 * cancel that already landed re-sends `job.cancel` to an agent that is already
 * unwinding, and re-driving one whose jobs are all terminal completes the run.
 *
 * @returns how many runs were re-driven.
 */
export async function sweepStuckCancelling(deps: SweepStuckCancellingDeps): Promise<number> {
  const cutoff = new Date(Date.now() - deps.stuckAfterMs);
  const stuck = await deps.db
    .selectFrom('execution_runs')
    .select(['run_id'])
    .where('status', '=', ExecutionRunStatus.enum.cancelling)
    // A NULL `cancelling_at` means the run entered `cancelling` before the
    // column existed, so its clock is unknown. Re-driving it is idempotent and
    // is the only way it ever leaves `cancelling`.
    .where((eb) => eb.or([eb('cancelling_at', 'is', null), eb('cancelling_at', '<', cutoff)]))
    .orderBy('cancelling_at', 'asc')
    .limit(MAX_PER_TICK)
    .execute();

  let redriven = 0;
  for (const row of stuck) {
    try {
      await deps.cancelRun(row.run_id, 'run cancelled (re-driven: cancel did not complete)');
      redriven++;
    } catch (err) {
      logger.warn('Stuck-cancelling re-drive failed', {
        runId: row.run_id,
        error: toErrorMessage(err),
      });
    }
  }
  if (redriven > 0) {
    logger.info('Re-drove runs stuck in cancelling', { redriven, examined: stuck.length });
  }
  return redriven;
}
