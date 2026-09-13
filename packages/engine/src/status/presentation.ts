/**
 * Shared execution-status presentation vocabulary: the canonical status union,
 * a total precedence order for roll-up aggregates, legacy-spelling resolution,
 * and a per-status failure classification.
 *
 * Pure Zod (browser-safe): the engine barrel re-exports this module and the
 * dashboard imports the barrel, so no Node built-in may appear here.
 *
 * Consumers keep their own presentation tables (badge colour, terminal colour,
 * emoji, webhook event type) — those are medium-specific. What lives here is
 * the vocabulary itself and the two questions every consumer asks about it:
 * "which of these statuses wins?" and "is this status a failure?".
 */
import { z } from 'zod';
import { ExecutionJobStatus, ExecutionRunStatus } from '../protocol/messages/execution-status.js';

/**
 * Every status a run or a job can hold. `ExecutionStepStatus` is a strict
 * subset (running / success / failed / skipped / pending / cancelled), so a
 * table keyed by this union also covers step surfaces.
 */
export type CanonicalStatus = ExecutionRunStatus | ExecutionJobStatus;

/** Every canonical status, derived from the engine enums so it cannot drift. */
export const CANONICAL_STATUSES: readonly CanonicalStatus[] = Object.freeze([
  ...new Set<CanonicalStatus>([...ExecutionRunStatus.options, ...ExecutionJobStatus.options]),
]);

const CANONICAL_SET: ReadonlySet<string> = new Set<string>(CANONICAL_STATUSES);

/**
 * Precedence rank for roll-up aggregates — LOWER wins.
 *
 * Exhaustive by type: adding a value to either engine enum breaks this file's
 * typecheck. That is the whole point — `STATUS_PRECEDENCE` below is a plain
 * array, and an array literal missing a member would compile silently, so the
 * ordered list is derived from this record rather than written by hand.
 *
 *  - Failures outrank in-flight states, so one failed shard reddens a matrix
 *    group immediately rather than waiting for its siblings to settle.
 *  - `cancelling` sits above `recovering` and `running`: an in-flight cancel
 *    must stay visible on the group header.
 *  - `unroutable` sits beside the other "declared but never ran" failures: a
 *    job whose `runsOn` matched no agent must redden its group, since the
 *    workflow did not do what it declared.
 *  - `cancelled` sits below the actively-executing states (`running`,
 *    `recovering`, `cancelling`) but ABOVE the not-yet-started ones (`held`,
 *    `queued`, `pending`). A band with a live child is still running whatever
 *    happened to its cancelled sibling; a band whose only news is that a child
 *    was cancelled reads "Cancelled" rather than "Queued", because the
 *    cancellation is the thing an operator needs to see.
 *  - `success` outranks `skipped`, so a matrix where three shards were narrowed
 *    out and one passed reads green. Only a group with no successful child
 *    reads "Skipped".
 */
const STATUS_RANK: Readonly<Record<CanonicalStatus, number>> = Object.freeze({
  [ExecutionJobStatus.enum.failed]: 0,
  [ExecutionJobStatus.enum.timed_out_stale]: 1,
  [ExecutionJobStatus.enum.drift_dropped]: 2,
  [ExecutionJobStatus.enum.unroutable]: 3,
  [ExecutionJobStatus.enum.cancelling]: 4,
  [ExecutionJobStatus.enum.recovering]: 5,
  [ExecutionJobStatus.enum.running]: 6,
  [ExecutionJobStatus.enum.cancelled]: 7,
  [ExecutionRunStatus.enum.held]: 8,
  [ExecutionJobStatus.enum.queued]: 9,
  [ExecutionJobStatus.enum.pending]: 10,
  [ExecutionJobStatus.enum.success]: 11,
  [ExecutionJobStatus.enum.skipped]: 12,
});

/** Canonical statuses ordered worst-first. Derived from `STATUS_RANK`. */
export const STATUS_PRECEDENCE: readonly CanonicalStatus[] = Object.freeze(
  [...CANONICAL_STATUSES].sort((a, b) => STATUS_RANK[a] - STATUS_RANK[b]),
);

/**
 * Legacy status spellings that map onto a canonical status. An alias always
 * resolves like the status it aliases, so a consumer never needs a second
 * hand-written copy of the mapping.
 */
export const LEGACY_STATUS_ALIASES: Readonly<Record<string, CanonicalStatus>> = Object.freeze({
  passed: ExecutionRunStatus.enum.success,
  completed: ExecutionRunStatus.enum.success,
  in_progress: ExecutionRunStatus.enum.running,
  error: ExecutionRunStatus.enum.failed,
  canceled: ExecutionRunStatus.enum.cancelled,
  waiting: ExecutionRunStatus.enum.pending,
});

/**
 * Resolve a status string onto its canonical status, or `undefined` when it is
 * neither canonical nor a known legacy alias. Callers that accept mixed case
 * lowercase their input first.
 *
 * `Object.hasOwn`, not a bare index: an object literal inherits
 * `Object.prototype`, so indexing it with `toString` / `constructor` /
 * `valueOf` would yield a function rather than `undefined` and the caller's
 * fallback would never fire.
 */
export function toCanonicalStatus(status: string): CanonicalStatus | undefined {
  if (Object.hasOwn(LEGACY_STATUS_ALIASES, status)) return LEGACY_STATUS_ALIASES[status];
  return CANONICAL_SET.has(status) ? (status as CanonicalStatus) : undefined;
}

/**
 * The winning status for a group of children, by `STATUS_RANK` precedence.
 *
 * Returns `undefined` when no input resolves, so the caller decides what to
 * show rather than being handed a fabricated status. A roll-up must never
 * invent "queued" or "success" for a child it did not recognise.
 *
 * An unrecognised child in an OTHERWISE resolvable group is skipped, so the
 * aggregate reports the worst status this build understands. That is a
 * deliberate trade: the alternative — refusing to aggregate at all — would blank
 * the group header for one unknown child. It does mean an older bundle talking
 * to a newer orchestrator can report a group as `success` when an unrecognised
 * sibling was in fact a failure; the per-child badges still render each unknown
 * status on its own terms, which is where the discrepancy is visible.
 */
export function worstStatus(statuses: readonly string[]): CanonicalStatus | undefined {
  let best: CanonicalStatus | undefined;
  for (const raw of statuses) {
    const canonical = toCanonicalStatus(raw);
    if (canonical === undefined) continue;
    if (best === undefined || STATUS_RANK[canonical] < STATUS_RANK[best]) best = canonical;
  }
  return best;
}

/**
 * How a status counts when deciding whether something failed.
 *
 *  - `failure`   — the workflow did not do what it declared. Drives the run
 *                  roll-up and the `on-failure` needs-edge expansion.
 *  - `cancelled` — deliberately stopped; its own outcome, not a failure.
 *  - `neutral`   — terminal but never ran (skipped).
 *  - `success`   — passed.
 *  - `in-flight` — not terminal yet.
 */
export const StatusFailureClass = z.enum([
  'failure',
  'cancelled',
  'neutral',
  'success',
  'in-flight',
]);
export type StatusFailureClass = z.infer<typeof StatusFailureClass>;

/**
 * Failure classification for every canonical status. Exhaustive by type, for
 * the same reason as `STATUS_RANK`.
 *
 * `drift_dropped` is a `failure`: the job was dropped by determinism drift on
 * the executing agent, so a job the workflow declared did not run. The run
 * roll-up and the `on-failure` needs-edge both read this one table, which is
 * what stops them from disagreeing.
 */
export const STATUS_FAILURE_CLASS: Readonly<Record<CanonicalStatus, StatusFailureClass>> =
  Object.freeze({
    [ExecutionJobStatus.enum.failed]: StatusFailureClass.enum.failure,
    [ExecutionJobStatus.enum.timed_out_stale]: StatusFailureClass.enum.failure,
    [ExecutionJobStatus.enum.drift_dropped]: StatusFailureClass.enum.failure,
    [ExecutionJobStatus.enum.unroutable]: StatusFailureClass.enum.failure,
    [ExecutionJobStatus.enum.cancelled]: StatusFailureClass.enum.cancelled,
    [ExecutionJobStatus.enum.skipped]: StatusFailureClass.enum.neutral,
    [ExecutionJobStatus.enum.success]: StatusFailureClass.enum.success,
    [ExecutionJobStatus.enum.pending]: StatusFailureClass.enum['in-flight'],
    [ExecutionJobStatus.enum.queued]: StatusFailureClass.enum['in-flight'],
    [ExecutionJobStatus.enum.running]: StatusFailureClass.enum['in-flight'],
    [ExecutionJobStatus.enum.recovering]: StatusFailureClass.enum['in-flight'],
    [ExecutionJobStatus.enum.cancelling]: StatusFailureClass.enum['in-flight'],
    [ExecutionRunStatus.enum.held]: StatusFailureClass.enum['in-flight'],
  });

/** True when a status means the workflow did not do what it declared. */
export function isFailureStatus(status: string): boolean {
  // Lowercases first, like the presentation helpers. This one is read by both
  // the engine's `on-failure` expansion and the orchestrator's run roll-up, and
  // a case-sensitive classification would answer `false` for a status those two
  // otherwise agree on.
  const canonical = toCanonicalStatus(status.toLowerCase());
  return (
    canonical !== undefined && STATUS_FAILURE_CLASS[canonical] === StatusFailureClass.enum.failure
  );
}
