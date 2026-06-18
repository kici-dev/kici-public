/**
 * Shared held-run resolution for the `kici approve` / `kici reject` commands.
 *
 * Both commands first list the pending holds for a run, then resolve the one
 * the user named via `--job` / `--step` (or the sole pending hold when there is
 * exactly one and no filter is given). The resolution is a pure function so it
 * can be unit-tested without HTTP.
 */

/** Hold scope, mirroring the engine `HoldScope` enum. */
export type HeldRunScope = 'workflow' | 'job' | 'step';

/** A pending-hold row as returned by `GET /orgs/:orgId/held-runs`. */
export interface HeldRunSummary {
  id: string;
  runId: string;
  jobId?: string;
  holdScope?: HeldRunScope;
  stepIndex?: number | null;
  status: string;
}

/** Filters supplied on the command line. */
export interface HeldRunFilter {
  /** Match a hold by its job name. */
  job?: string;
  /** Match a step-scoped hold by its step index (compared as a string). */
  step?: string;
}

/** Resolution result: either a held-run id or a user-facing error message. */
export type ResolveResult =
  | { ok: true; heldRunId: string; hold: HeldRunSummary }
  | { ok: false; error: string };

/**
 * Resolve the held-run id matching the filter from a list of pending holds.
 *
 * - `--step` requires `--job` and matches a `step`-scoped hold whose step index
 *   equals the given value.
 * - `--job` alone matches a `job`/`workflow`-scoped hold for that job.
 * - With no filter, the sole pending hold is used; ambiguity is an error.
 */
export function resolveHeldRunId(
  holds: readonly HeldRunSummary[],
  filter: HeldRunFilter,
): ResolveResult {
  const pending = holds.filter((h) => h.status === 'pending');
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
    return pickSingle(matches, `step ${filter.step} of job '${filter.job}'`);
  }

  if (filter.job !== undefined) {
    const matches = pending.filter((h) => h.jobId === filter.job && h.holdScope !== 'step');
    return pickSingle(matches, `job '${filter.job}'`);
  }

  if (pending.length > 1) {
    return {
      ok: false,
      error:
        'Multiple pending holds for this run. Use --job <name> (and --step <index>) to choose one.',
    };
  }
  return { ok: true, heldRunId: pending[0].id, hold: pending[0] };
}

function pickSingle(matches: readonly HeldRunSummary[], label: string): ResolveResult {
  if (matches.length === 0) {
    return { ok: false, error: `No pending hold found for ${label}.` };
  }
  if (matches.length > 1) {
    return { ok: false, error: `Multiple pending holds match ${label}; cannot disambiguate.` };
  }
  return { ok: true, heldRunId: matches[0].id, hold: matches[0] };
}
