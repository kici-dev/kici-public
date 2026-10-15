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
  cancelRun: (runId: string, reason: string, options: { force: boolean }) => Promise<unknown>;
  /**
   * Time in `cancelling` before a re-drive: twice the recovery grace period, so
   * a graceful teardown finishes on its own but a dropped cancel does not sit
   * for an hour.
   */
  stuckAfterMs: number;
}

/**
 * Re-drive the cancel for runs left in `cancelling`. A peer blip drops a cancel
 * sent over the peer channel, leaving the jobs executing; the workflow-deadline
 * detector re-scans `cancelling` runs only when they HAVE a workflow timeout,
 * so this covers every other run.
 *
 * Leader-gated by its caller, and idempotent: re-driving re-sends `job.cancel`
 * to an agent already unwinding, or completes a run whose jobs are all terminal.
 *
 * @returns how many runs were re-driven.
 */
export async function sweepStuckCancelling(deps: SweepStuckCancellingDeps): Promise<number> {
  const cutoff = new Date(Date.now() - deps.stuckAfterMs);
  const stuck = await deps.db
    .selectFrom('execution_runs')
    .select(['run_id', 'cancel_force'])
    .where('status', '=', ExecutionRunStatus.enum.cancelling)
    // A NULL `cancelling_at` (run entered `cancelling` before the column
    // existed) has no clock; re-driving is idempotent and its only way out.
    .where((eb) => eb.or([eb('cancelling_at', 'is', null), eb('cancelling_at', '<', cutoff)]))
    .orderBy('cancelling_at', 'asc')
    .limit(MAX_PER_TICK)
    .execute();

  let redriven = 0;
  for (const row of stuck) {
    try {
      // A forced cancel (`execution_runs.cancel_force`) is re-sent forced.
      await deps.cancelRun(row.run_id, 'run cancelled (re-driven: cancel did not complete)', {
        force: row.cancel_force === true,
      });
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
