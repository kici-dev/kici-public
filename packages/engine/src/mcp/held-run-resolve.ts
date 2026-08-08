/**
 * Shared held-run resolution for the `kici approve` / `kici reject` commands and
 * the developer MCP `approve_run` / `reject_run` tools.
 *
 * Both surfaces first list the pending holds for a run, then resolve the one
 * the caller named via `job` / `step` (or the sole pending hold when there is
 * exactly one and no filter is given). The resolution is a pure function so it
 * can be unit-tested without HTTP, and it imports nothing beyond the shared
 * held-run vocabulary, so it is safe to re-export from the browser-facing
 * engine barrel.
 */
import { HeldRunStatus } from '../context/held-run-status.js';

/** Hold scope, mirroring the engine `HoldScope` enum. */
export type HeldRunScope = 'workflow' | 'job' | 'step';

/** A pending-hold row as returned by the held-runs list. */
export interface HeldRunSummary {
  id: string;
  runId: string;
  jobId?: string;
  holdScope?: HeldRunScope;
  stepIndex?: number | null;
  status: string;
  /**
   * Persisted `held_runs.hold_type`, when the orchestrator's list response
   * carried one. Optional and un-normalized: callers pass it through
   * `normalizePersistedHoldType` before branching. Absent from an older
   * orchestrator's response.
   */
  holdType?: string;
  /** Computed drift payload for a `when: 'drift'` step hold; absent otherwise. */
  payload?: { summaryMarkdown: string; drift?: unknown } | null;
}

/** Filters supplied by the caller. */
export interface HeldRunFilter {
  /** Match a hold by its job name. */
  job?: string;
  /** Match a step-scoped hold by its step index (compared as a string). */
  step?: string;
}

/** Resolution result: either a held-run id or a user-facing error message. */
export type ResolveResult =
  { ok: true; heldRunId: string; hold: HeldRunSummary } | { ok: false; error: string };

/**
 * Name a hold the way the caller would type it: the literal `jobId` (so an
 * `__install__…` sentinel or an opaque legacy id is reproduced verbatim), with
 * the step index prefixed for a step-scoped hold.
 */
function describeHold(hold: HeldRunSummary): string {
  // `||`, not `??`: an empty `jobId` is as unnameable as a missing one, and
  // would otherwise render as a blank entry in the candidate list.
  const job = hold.jobId || '(unnamed hold)';
  if (hold.holdScope === 'step' && hold.stepIndex != null) {
    return `step ${hold.stepIndex} of ${job}`;
  }
  return job;
}

/** The distinct hold descriptions, in listing order, for an error message. */
function listCandidates(holds: readonly HeldRunSummary[]): string {
  return [...new Set(holds.map(describeHold))].join(', ');
}

/**
 * Resolve the held-run id matching the filter from a list of pending holds.
 *
 * - `step` requires `job` and matches a `step`-scoped hold whose step index
 *   equals the given value.
 * - `job` alone matches a `job`/`workflow`-scoped hold for that job.
 * - With no filter, the sole pending hold is used; ambiguity is an error.
 */
export function resolveHeldRunId(
  holds: readonly HeldRunSummary[],
  filter: HeldRunFilter,
): ResolveResult {
  const pending = holds.filter((h) => h.status === HeldRunStatus.enum.pending);
  if (pending.length === 0) {
    return { ok: false, error: 'No pending approval holds found for this run.' };
  }

  if (filter.step !== undefined) {
    if (!filter.job) {
      return { ok: false, error: '--step requires --job to identify the held step.' };
    }
    const matches = pending.filter(
      (h) =>
        h.holdScope === 'step' &&
        h.jobId === filter.job &&
        String(h.stepIndex ?? '') === filter.step,
    );
    return pickSingle(matches, `step ${filter.step} of job '${filter.job}'`, pending);
  }

  if (filter.job !== undefined) {
    const matches = pending.filter((h) => h.jobId === filter.job && h.holdScope !== 'step');
    return pickSingle(matches, `job '${filter.job}'`, pending);
  }

  if (pending.length > 1) {
    return {
      ok: false,
      error:
        'Multiple pending holds for this run. Use --job <name> (and --step <index>) to choose one. ' +
        `Candidates: ${listCandidates(pending)}.`,
    };
  }
  return { ok: true, heldRunId: pending[0].id, hold: pending[0] };
}

function pickSingle(
  matches: readonly HeldRunSummary[],
  label: string,
  pending: readonly HeldRunSummary[],
): ResolveResult {
  if (matches.length === 0) {
    return {
      ok: false,
      error: `No pending hold found for ${label}. Pending holds: ${listCandidates(pending)}.`,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error:
        `Multiple pending holds match ${label}; cannot disambiguate. ` +
        `Candidates: ${listCandidates(matches)}.`,
    };
  }
  return { ok: true, heldRunId: matches[0].id, hold: matches[0] };
}
