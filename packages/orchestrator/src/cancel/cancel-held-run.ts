/**
 * Cancel a run that sits `held` behind an approval request.
 *
 * A held run has no job and no dispatch yet: what it has is a pending
 * `held_runs` row, the pending `KiCI Security` check a security hold posted,
 * and the stored dispatch context an approve would replay. Cancelling it has to
 * settle all three, or a later approve still finds its hold pending, replays
 * the stored dispatch, and closes the check as approved for a run that was
 * cancelled. So a cancel withdraws the approval request through the path a
 * reject takes: each pending hold of the run is flipped `rejected` with the
 * cancel reason, then handed to the workflow-hold rejection
 * (`rejectWorkflow`), which cancels the run, completes the checks the held
 * dispatch posted, settles the security check, and drops the stored context.
 */
import type { Kysely } from 'kysely';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { HoldScope } from '@kici-dev/engine';
import type { Database, HeldRun } from '../db/types.js';
import { HeldRunStatus, HeldRunStore } from '../contexts/held-runs.js';
import type { ExecutionTracker } from '../reporting/execution-tracker.js';

const logger = createLogger({ prefix: 'cancel-held-run' });

/** How a cancel of a held run's approval requests ended. */
export enum HeldRunWithdrawal {
  /** The cancel rejected at least one pending hold itself. */
  Withdrawn = 'withdrawn',
  /** An approve released the run first, so it is resuming. */
  Approved = 'approved',
  /** A reject decided the hold first, and that rejection ends the run. */
  Rejected = 'rejected',
  /** The hold expired first, and that expiry ends the run. */
  Expired = 'expired',
}

/** A decision on a held run that reached its holds before a cancel did. */
export type HeldRunDecidedFirst = Exclude<HeldRunWithdrawal, HeldRunWithdrawal.Withdrawn>;

/** Options for a workflow-hold rejection reached through a cancel. */
export interface RejectHeldWorkflowOptions {
  /**
   * False when the run is not `held`: the rejection then settles the checks
   * and drops the stored context but leaves the run row to the job
   * cancellation that follows. Defaults to true.
   */
  runHeld?: boolean;
}

/** Options for {@link cancelHeldRunWithReason}. */
export interface CancelHeldRunOptions {
  /**
   * False when the caller ends the run itself — a cancel of a run that is not
   * `held`, whose jobs are cancelled next. The holds are still rejected and
   * the checks settled, but no held-run terminal write is attempted: it would
   * match no row and only report a missing held run. Defaults to true.
   */
  terminalWrite?: boolean;
}

export interface CancelHeldRunDeps {
  db: Kysely<Database>;
  executionTracker: ExecutionTracker;
  /**
   * The workflow-hold rejection (`rejectWorkflow` bound to live processing
   * deps). Undefined where no provider wiring exists: the run is then cancelled
   * and its holds rejected, but no provider check is settled.
   */
  rejectHeldWorkflow?:
    | ((hold: HeldRun, reason: string, opts?: RejectHeldWorkflowOptions) => Promise<boolean>)
    | undefined;
}

/**
 * Withdraw every pending approval request of a held run and cancel the run.
 * Returns {@link HeldRunWithdrawal.Withdrawn} when this call withdrew the run.
 * Otherwise a decision reached every hold first — an approve, a reject or an
 * expiry, which the result names — the call writes nothing, and the caller
 * refuses the cancel.
 */
export async function cancelHeldRunWithReason(
  deps: CancelHeldRunDeps,
  runId: string,
  reason: string,
  opts: CancelHeldRunOptions = {},
): Promise<HeldRunWithdrawal> {
  const { db, executionTracker } = deps;
  const terminalWrite = opts.terminalWrite ?? true;
  const allHolds = await db
    .selectFrom('held_runs')
    .selectAll()
    .where('run_id', '=', runId)
    .execute();
  if (allHolds.length === 0) {
    // A held row with no hold at all: nothing can release it, so it only needs
    // the terminal write.
    if (terminalWrite) await executionTracker.cancelHeldRun(runId, reason);
    return HeldRunWithdrawal.Withdrawn;
  }
  const holds = allHolds.filter((hold) => hold.status === HeldRunStatus.Pending);

  const store = new HeldRunStore(db);
  let withdrawn = false;
  let runCancelled = false;
  for (const hold of holds) {
    const rejected = await rejectPending(store, hold, reason);
    if (!rejected) continue;
    withdrawn = true;
    // The rejection cancels the run and settles the commit's checks, so it runs
    // once per run; a further workflow hold only needs its row rejected above.
    if (rejected.hold_scope !== HoldScope.enum.workflow || runCancelled) continue;
    await withdrawWorkflowHold(deps, rejected, reason, terminalWrite);
    runCancelled = true;
  }
  // A run whose only rejected holds were not workflow-scoped still ends here.
  // fails-when: a cancel of a non-held run attempts the held-run terminal write
  // breaks-if-wrong: a held run with only job-scoped holds must still be cancelled
  if (withdrawn && !runCancelled && terminalWrite) {
    await executionTracker.cancelHeldRun(runId, reason);
  }
  return withdrawn ? HeldRunWithdrawal.Withdrawn : await decisionThatWon(db, runId);
}

/**
 * Which decision reached a held run's holds before the cancel. An approve wins
 * the naming over a reject or an expiry of another hold of the same run: the
 * run is resuming, so a cancel sent now can still reach it once it runs.
 */
async function decisionThatWon(db: Kysely<Database>, runId: string): Promise<HeldRunDecidedFirst> {
  const rows = await db
    .selectFrom('held_runs')
    .select('status')
    .where('run_id', '=', runId)
    .execute();
  const statuses = new Set(rows.map((row) => row.status));
  // fails-when: a hold a reject decided is reported as an approve, so the caller says "resuming"
  // breaks-if-wrong: a run an approve released must still read as resuming after approval
  if (statuses.has(HeldRunStatus.Approved) || statuses.has(HeldRunStatus.Released)) {
    return HeldRunWithdrawal.Approved;
  }
  if (statuses.has(HeldRunStatus.Rejected)) return HeldRunWithdrawal.Rejected;
  if (statuses.has(HeldRunStatus.Expired)) return HeldRunWithdrawal.Expired;
  return HeldRunWithdrawal.Approved;
}

/** Flip one pending hold to `rejected`; undefined when a decision got there first. */
async function rejectPending(
  store: HeldRunStore,
  hold: HeldRun,
  reason: string,
): Promise<HeldRun | undefined> {
  try {
    return await store.reject(hold.org_id, hold.id, reason);
  } catch (err) {
    logger.info('Cancel of a held run lost the hold to a decision', {
      runId: hold.run_id,
      heldRunId: hold.id,
      error: toErrorMessage(err),
    });
    return undefined;
  }
}

/** Run the workflow-hold rejection for a hold the cancel rejected. */
async function withdrawWorkflowHold(
  deps: CancelHeldRunDeps,
  hold: HeldRun,
  reason: string,
  terminalWrite: boolean,
): Promise<void> {
  if (!deps.rejectHeldWorkflow) {
    if (terminalWrite) await deps.executionTracker.cancelHeldRun(hold.run_id, reason);
    return;
  }
  try {
    await deps.rejectHeldWorkflow(hold, reason, { runHeld: terminalWrite });
  } catch (err) {
    // The hold is already rejected, so no approve can release the run; the
    // terminal write still has to land.
    logger.error('Failed to withdraw a held run after its hold was rejected by a cancel', {
      runId: hold.run_id,
      heldRunId: hold.id,
      error: toErrorMessage(err),
    });
    if (terminalWrite) await deps.executionTracker.cancelHeldRun(hold.run_id, reason);
  }
}
