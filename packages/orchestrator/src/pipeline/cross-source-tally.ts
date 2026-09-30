/**
 * A generic delivery can run both halves — cross-source for other sources'
 * registrations, and the inbound source's own lock when its normalizer reads a
 * repository. The delivery still gets one event-log row: the same-source path
 * writes it, and this wrapper folds the cross-source half into it.
 */
import type { ProcessingDeps } from './processor.js';
import { DEGRADED_CHANGED_FILES_REASON } from './degraded-reason.js';

export interface CrossSourceTally {
  candidatesConsidered: number;
  jobsDispatched: number;
  /** A cross-source candidate evaluated `paths` against an unavailable diff. */
  degraded: boolean;
}

/**
 * Wrap `deps.eventLog` so whichever row the same-source path records — corrupt
 * lock, missing lock, skip or processed — also counts the cross-source half's
 * dispatched jobs and carries its degraded reason. A reason the same-source
 * path already set wins.
 */
export function withCrossSourceTally(
  deps: ProcessingDeps,
  tally: CrossSourceTally,
): ProcessingDeps {
  const inner = deps.eventLog;
  if (!inner) return deps;
  return {
    ...deps,
    eventLog: {
      record: (info, payload, outcome, options) =>
        inner.record(
          info,
          payload,
          {
            ...outcome,
            matchedCount: (outcome.matchedCount ?? 0) + tally.jobsDispatched,
            errorMessage:
              outcome.errorMessage ?? (tally.degraded ? DEGRADED_CHANGED_FILES_REASON : undefined),
          },
          options,
        ),
    },
  };
}
