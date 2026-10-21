/**
 * Dispatch work for a request that has already been answered.
 *
 * A run-minting request (a re-run, a schedule fired by hand) is answered once
 * the orchestrator has validated it and claimed its request id. The dispatch
 * that follows can wait minutes on a cold source or dependency cache, while the
 * relayed dashboard call that asked for it has a budget of seconds. So the
 * requester gets the run id of the accepted run, and the dispatch continues
 * here.
 *
 * A dispatch that throws after the answer is recorded on the run it was
 * dispatching, through `recordFailure`: the requester holds that run id and
 * reads the failure from it. The first path that answered early this way was
 * the re-run of a failed global evaluation round (`rerun.ts`).
 *
 * The work starts inside the caller's call, through `Promise.resolve().then`,
 * so it runs in the caller's async context: the dispatch reads the request's
 * id from it.
 */
import { createLogger, toErrorMessage } from '@kici-dev/shared';

const logger = createLogger({ prefix: 'accepted-dispatch' });

/** Dispatches started and not yet settled. Every entry handles its own failure, so none rejects. */
const inFlight = new Set<Promise<void>>();

export interface AcceptedDispatch {
  /** The run the requester was told about. */
  runId: string;
  /** What is dispatched, as the recorded failure names it (`Re-run`). */
  kind: string;
  /** The dispatch. Awaited by nobody but this module. */
  work: () => Promise<void>;
  /** Record a failed dispatch on the run, with the reason the requester reads. */
  recordFailure: (reason: string) => Promise<void>;
  /** Extra fields for the log lines. */
  context?: Record<string, unknown>;
}

/**
 * Start `work` for a request the caller is about to answer. Returns at once;
 * the work settles on its own.
 */
export function startAcceptedDispatch(dispatch: AcceptedDispatch): void {
  const { runId, kind, work, recordFailure, context } = dispatch;
  const settled = Promise.resolve()
    .then(work)
    .catch(async (err: unknown) => {
      const reason = `${kind} could not be dispatched: ${toErrorMessage(err)}`;
      logger.error('Dispatch failed after the request was answered', {
        ...context,
        runId,
        error: reason,
      });
      try {
        await recordFailure(reason);
      } catch (recordErr) {
        logger.error('Could not record a failed dispatch on its run', {
          ...context,
          runId,
          reason,
          error: toErrorMessage(recordErr),
        });
      }
    })
    .finally(() => {
      inFlight.delete(settled);
    });
  inFlight.add(settled);
}

/**
 * Settle every accepted dispatch started so far. A running orchestrator never
 * calls it: it lets a test wait deterministically instead of racing the
 * microtask queue.
 */
export async function settleAcceptedDispatches(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.all([...inFlight]);
  }
}
