/**
 * The admin cancel route's answer for a cancel that did not find the run
 * already terminal. Kept apart from the route so the mapping is testable
 * without assembling the whole app.
 */
import { ExecutionRunStatus } from '@kici-dev/engine';
import { HeldRunWithdrawal, type HeldRunDecidedFirst } from './cancel-held-run.js';
import { heldRunCancelRefusal, type CancelRunResult } from './cancel-run.js';

/** The access-log note of a cancel refused because a decision reached the held run first. */
const REFUSAL_NOTES: Record<HeldRunDecidedFirst, string> = {
  [HeldRunWithdrawal.Approved]: 'run is resuming after approval',
  [HeldRunWithdrawal.Rejected]: 'run was rejected before the cancel',
  [HeldRunWithdrawal.Expired]: 'run approval request expired before the cancel',
};

export interface CancelRouteAnswer {
  httpStatus: 200 | 409;
  body:
    | { status: ExecutionRunStatus; cancelledJobs: number }
    | { error: string; status: ExecutionRunStatus };
  /** Note recorded on the access-log row, when the answer is not a plain success. */
  accessNote?: string;
}

export function cancelRouteAnswer(result: CancelRunResult): CancelRouteAnswer {
  // A decision reached the held run's holds first: the cancel wrote nothing,
  // so it must not answer as a cancellation.
  // fails-when: a cancel that lost to an approve or a reject answers 200 cancelled
  // breaks-if-wrong: a cancelled held run must still answer 200 cancelled
  if (result.decidedBeforeCancel) {
    return {
      httpStatus: 409,
      body: {
        error: heldRunCancelRefusal(result.decidedBeforeCancel),
        status: ExecutionRunStatus.enum.held,
      },
      accessNote: REFUSAL_NOTES[result.decidedBeforeCancel],
    };
  }
  // `unreachable` counts jobs whose owning coordinator is alive but could not
  // be reached, so the cancel did not land and the job is very likely still
  // running. Reporting `cancelled` there would tell the caller the deploy
  // stopped while it runs on. The run stays `cancelling` and the re-drive sweep
  // tries again.
  const status =
    result.agentsNotified > 0 || result.unreachable > 0
      ? ExecutionRunStatus.enum.cancelling
      : ExecutionRunStatus.enum.cancelled;
  return {
    httpStatus: 200,
    body: { status, cancelledJobs: result.agentsNotified + result.pendingCancelled },
  };
}
