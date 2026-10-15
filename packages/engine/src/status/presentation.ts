/**
 * Shared execution-status presentation vocabulary: the canonical status union,
 * a total precedence order for roll-up aggregates, canonical-status resolution,
 * and a per-status failure classification.
 *
 * Pure Zod: the dashboard imports it through the engine barrel, so no Node
 * built-in may appear here. Medium-specific tables (badge colour, terminal
 * colour, emoji, webhook event type) stay with each consumer.
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
 * Exhaustive by type: a new value in either engine enum breaks this file's
 * typecheck. `STATUS_PRECEDENCE` is derived from this record because an array
 * literal missing a member would compile silently.
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
 *    `queued`, `pending`): a band with a live child is still running, and
 *    otherwise the cancellation is what an operator needs to see.
 *  - `success` outranks `skipped`, so a matrix with narrowed-out shards and
 *    one pass reads green. Only a group with no successful child reads "Skipped".
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

/** Canonical statuses ordered worst-first. */
export const STATUS_PRECEDENCE: readonly CanonicalStatus[] = Object.freeze(
  [...CANONICAL_STATUSES].sort((a, b) => STATUS_RANK[a] - STATUS_RANK[b]),
);

/**
 * Resolve a status string onto its canonical status, or `undefined` when it is
 * not canonical. Callers that accept mixed case lowercase their input first.
 */
export function toCanonicalStatus(status: string): CanonicalStatus | undefined {
  return CANONICAL_SET.has(status) ? (status as CanonicalStatus) : undefined;
}

/**
 * The winning status for a group of children, by `STATUS_RANK` precedence.
 *
 * Returns `undefined` when no input resolves, so the caller decides what to
 * show; a roll-up never invents "queued" or "success" for an unrecognised child.
 *
 * An unrecognised child in an OTHERWISE resolvable group is skipped, since
 * refusing to aggregate would blank the group header for one unknown child. So
 * an older bundle talking to a newer orchestrator can report `success` when an
 * unrecognised sibling failed; the per-child badges still show that status.
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
 * `drift_dropped` is a `failure`: determinism drift on the executing agent
 * dropped a job the workflow declared. The run roll-up and the `on-failure`
 * needs-edge both read this one table, so they cannot disagree.
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
  // Lowercases first, like the presentation helpers: the engine's `on-failure`
  // expansion and the orchestrator's run roll-up both read it, and must agree.
  const canonical = toCanonicalStatus(status.toLowerCase());
  return (
    canonical !== undefined && STATUS_FAILURE_CLASS[canonical] === StatusFailureClass.enum.failure
  );
}
