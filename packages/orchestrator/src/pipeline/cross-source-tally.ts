/**
 * A generic delivery can run both cross-source (other sources' registrations)
 * and same-source (the inbound lock, when its normalizer reads a repository).
 * It still gets one event-log row: the same-source path writes it, and this
 * wrapper folds the cross-source half in.
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
 * Wrap `deps.eventLog` so any row the same-source path records (corrupt lock,
 * missing lock, skip, processed) adds the cross-source dispatched jobs and its
 * degraded reason; a same-source reason wins.
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
