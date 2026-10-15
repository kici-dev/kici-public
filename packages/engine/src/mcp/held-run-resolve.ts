/**
 * Shared held-run resolution for the `kici approve` / `kici reject` commands and
 * the developer MCP `approve_run` / `reject_run` tools.
 *
 * Pure (unit-testable without HTTP) and importing only the shared held-run
 * vocabulary, so it is safe to re-export from the browser-facing engine barrel.
 *
 * A job name is not a unique key: two independent requirements can gate one job,
 * and each writes its own pending row under that name. So every ambiguity path
 * here has to end at a filter that can actually separate them, and the candidate
 * list has to print enough for the caller to pick one.
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
  /** Persisted `held_runs.hold_type`; absent from an older orchestrator's response. */
  holdType?: string;
  /**
   * Bound context that requested the hold, when the row carries one. Null once
   * the context is deleted, and absent from an older orchestrator's response.
   */
  contextName?: string | null;
  /** Persisted `held_runs.queue_type` (`context` / `security`), when present. */
  queueType?: string;
  /** Why the hold was requested, when the row carries a reason. */
  reason?: string | null;
  /** When the hold expires, as an ISO timestamp; null when it never does. */
  expiresAt?: string | null;
  /** Computed drift payload for a `when: 'drift'` step hold; absent otherwise. */
  payload?: { summaryMarkdown: string; drift?: unknown } | null;
}

export interface HeldRunFilter {
  /** Match a hold by its job name. */
  job?: string;
  /** Match a step-scoped hold by its step index (compared as a string). */
  step?: string;
  /**
   * Match one hold by its own id, ignoring every other filter.
   *
   * The escape hatch for an ambiguity nothing else can resolve: {@link holdType}
   * separates today's same-job pair, but nothing guarantees a future pair differs
   * in type. The candidate list prints the ids whenever two holds are otherwise
   * indistinguishable.
   */
  holdId?: string;
  /**
   * Narrow to holds of one type (`reviewer` / `timer` / `concurrency` /
   * `security`), compared verbatim.
   *
   * Composes with {@link job} / {@link step} rather than replacing them: a
   * matrix whose children each carry two holds needs both halves.
   */
  holdType?: string;
}

/** Resolution result: either a held-run id or a user-facing error message. */
export type ResolveResult =
  { ok: true; heldRunId: string; hold: HeldRunSummary } | { ok: false; error: string };

/**
 * Name a hold the way the caller would type it: the literal `jobId` (so an
 * `__install__…` sentinel or an opaque legacy id is reproduced verbatim), with
 * the step index prefixed for a step-scoped hold, and the hold type appended.
 *
 * The type makes the candidate list actionable when one job carries two holds:
 * without it both rows render as the bare job name and collapse to a single
 * entry. It is omitted when an older orchestrator's response carried none.
 */
function describeHold(hold: HeldRunSummary): string {
  // `||`, not `??`: an empty `jobId` is as unnameable as a missing one, and
  // would otherwise render as a blank entry in the candidate list.
  const job = hold.jobId || '(unnamed hold)';
  const base =
    hold.holdScope === 'step' && hold.stepIndex != null ? `step ${hold.stepIndex} of ${job}` : job;
  return hold.holdType ? `${base} (${hold.holdType})` : base;
}

/**
 * The hold descriptions, in listing order, for an error message.
 *
 * A description that occurs once is listed once. One that occurs more than once
 * is listed per hold WITH its id, because then `--hold <id>` is the only filter
 * that can name the hold the caller means; de-duplicating would discard it.
 */
function listCandidates(holds: readonly HeldRunSummary[]): string {
  const counts = new Map<string, number>();
  for (const hold of holds) {
    const text = describeHold(hold);
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  const emitted = new Set<string>();
  const out: string[] = [];
  for (const hold of holds) {
    const text = describeHold(hold);
    if ((counts.get(text) ?? 0) > 1) {
      out.push(`${text} [${hold.id}]`);
      continue;
    }
    if (emitted.has(text)) continue;
    emitted.add(text);
    out.push(text);
  }
  return out.join(', ');
}

/** The disambiguators a caller can reach for, named the way the CLI spells them. */
const DISAMBIGUATORS = '--job <name>, --step <index>, --hold-type <type> or --hold <id>';

/**
 * Resolve the held-run id matching the filter from a list of pending holds.
 *
 * - `holdId` names one hold outright and ignores every other filter.
 * - `step` requires `job` and matches a `step`-scoped hold whose step index
 *   equals the given value.
 * - `job` alone matches a `job`/`workflow`-scoped hold for that job.
 * - `holdType` narrows whichever set the above produced, and may be used on its
 *   own.
 * - With no filter, the sole pending hold is used; ambiguity is an error.
 *
 * An SDK `requireApproval` paired with a security-typed context gate writes two
 * job-scoped rows under one job name, both of which must be answered; `job`
 * alone cannot separate them, which is what `holdType` and `holdId` are for.
 */
export function resolveHeldRunId(
  holds: readonly HeldRunSummary[],
  filter: HeldRunFilter,
): ResolveResult {
  const pending = holds.filter((h) => h.status === HeldRunStatus.enum.pending);
  if (pending.length === 0) {
    return { ok: false, error: 'No pending approval holds found for this run.' };
  }

  if (filter.holdId !== undefined) {
    const matches = pending.filter((h) => h.id === filter.holdId);
    return pickSingle(matches, `hold '${filter.holdId}'`, pending);
  }

  const wanted = filter.holdType;
  const byType = (candidates: readonly HeldRunSummary[]): readonly HeldRunSummary[] =>
    wanted === undefined ? candidates : candidates.filter((h) => h.holdType === wanted);
  const typeLabel = wanted ? ` of type '${wanted}'` : '';

  if (filter.step !== undefined) {
    if (!filter.job) {
      return { ok: false, error: '--step requires --job to identify the held step.' };
    }
    const matches = byType(
      pending.filter(
        (h) =>
          h.holdScope === 'step' &&
          h.jobId === filter.job &&
          String(h.stepIndex ?? '') === filter.step,
      ),
    );
    return pickSingle(matches, `step ${filter.step} of job '${filter.job}'${typeLabel}`, pending);
  }

  if (filter.job !== undefined) {
    const matches = byType(pending.filter((h) => h.jobId === filter.job && h.holdScope !== 'step'));
    return pickSingle(matches, `job '${filter.job}'${typeLabel}`, pending);
  }

  if (wanted !== undefined) {
    return pickSingle(byType(pending), `hold type '${wanted}'`, pending);
  }

  if (pending.length > 1) {
    return {
      ok: false,
      error:
        `Multiple pending holds for this run. Use ${DISAMBIGUATORS} to choose one. ` +
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
        `Multiple pending holds match ${label}. Narrow it with ${DISAMBIGUATORS}. ` +
        `Candidates: ${listCandidates(matches)}.`,
    };
  }
  return { ok: true, heldRunId: matches[0].id, hold: matches[0] };
}
