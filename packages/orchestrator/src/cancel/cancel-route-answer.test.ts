import { describe, expect, it } from 'vitest';
import { ExecutionRunStatus } from '@kici-dev/engine';
import { cancelRouteAnswer } from './cancel-route-answer.js';
import { HeldRunWithdrawal } from './cancel-held-run.js';
import {
  RUN_EXPIRED_BEFORE_CANCEL_MESSAGE,
  RUN_REJECTED_BEFORE_CANCEL_MESSAGE,
  RUN_RESUMING_AFTER_APPROVAL_MESSAGE,
  type CancelRunResult,
} from './cancel-run.js';

const base: CancelRunResult = {
  agentsNotified: 0,
  unreachable: 0,
  pendingCancelled: 0,
  alreadyTerminal: false,
};

describe('cancelRouteAnswer', () => {
  it('answers 409 for a held run that is resuming after approval', () => {
    // fails-when: a cancel that lost to an approve answers 200 cancelled
    expect(cancelRouteAnswer({ ...base, decidedBeforeCancel: HeldRunWithdrawal.Approved })).toEqual(
      {
        httpStatus: 409,
        body: { error: RUN_RESUMING_AFTER_APPROVAL_MESSAGE, status: ExecutionRunStatus.enum.held },
        accessNote: 'run is resuming after approval',
      },
    );
  });

  it('names the reject or the expiry that reached the held run first', () => {
    // fails-when: every refusal answers with the approval message
    expect(
      cancelRouteAnswer({ ...base, decidedBeforeCancel: HeldRunWithdrawal.Rejected }),
    ).toMatchObject({
      httpStatus: 409,
      body: { error: RUN_REJECTED_BEFORE_CANCEL_MESSAGE },
      accessNote: 'run was rejected before the cancel',
    });
    expect(
      cancelRouteAnswer({ ...base, decidedBeforeCancel: HeldRunWithdrawal.Expired }).body,
    ).toMatchObject({ error: RUN_EXPIRED_BEFORE_CANCEL_MESSAGE });
  });

  it('answers 200 cancelled when no agent had work', () => {
    // breaks-if-wrong: an ordinary cancel still answers as a cancellation
    expect(cancelRouteAnswer({ ...base, pendingCancelled: 2 })).toEqual({
      httpStatus: 200,
      body: { status: ExecutionRunStatus.enum.cancelled, cancelledJobs: 2 },
    });
  });

  it('answers 200 cancelling while an agent unwinds or is unreachable', () => {
    expect(cancelRouteAnswer({ ...base, agentsNotified: 1 }).body).toEqual({
      status: ExecutionRunStatus.enum.cancelling,
      cancelledJobs: 1,
    });
    expect(cancelRouteAnswer({ ...base, unreachable: 1 }).body).toMatchObject({
      status: ExecutionRunStatus.enum.cancelling,
    });
  });
});
