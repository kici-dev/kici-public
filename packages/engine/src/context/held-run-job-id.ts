/**
 * Run-wide sentinel values for `held_runs.job_id`.
 *
 * The column normally carries the held job's expanded name (a matrix child
 * keeps its own `build (18)` form), which is what the dashboard approval queue
 * renders and what `kici approve --job <name>` resolves. Some holds are not
 * scoped to a single job and use a sentinel instead: the workflow install gate,
 * and the PR-wide security holds the org trust policy raises.
 *
 * The orchestrator writes these values and the dashboard reads them back to
 * render a human-meaningful row label, so they live here rather than as a
 * literal on each side — a rename on the writer must not silently stop the
 * reader from recognising the sentinel.
 */

/** Sentinel `job_id` for the PR-wide workflow-modification security hold. */
export const WORKFLOW_MODIFICATION_JOB_ID = '__workflow_modification__';

/**
 * Sentinel `job_id` per PR-wide security-hold reason, written when the org
 * trust policy holds a run.
 *
 * Each key keeps its historical value, so a hold written by any earlier build
 * still resolves by job id. The org trust policy raises `fork_pr`; the other two
 * are carried by rows written when it had more arms, and both stay here so the
 * dashboard can still render a label for them.
 *
 * `context_trust` is deliberately absent: that hold comes from the per-context
 * minimum-trust gate, which writes the real expanded job name (a matrix child
 * keeps its `build (18)` form) so the operator can approve that job
 * specifically. A sentinel for it would be a value nothing ever writes.
 *
 * Keyed by the orchestrator's security-hold reasons; the key set is asserted
 * against that vocabulary in the orchestrator's own test rather than importing
 * it here (the engine must not depend on the orchestrator).
 */
export const SECURITY_HOLD_JOB_IDS = {
  workflow_modification: WORKFLOW_MODIFICATION_JOB_ID,
  fork_pr: '__fork_pr__',
  unknown_contributor: '__unknown_contributor__',
} as const satisfies Record<string, string>;

/** Human-meaningful label per security-hold sentinel, rendered by the dashboard. */
export const SECURITY_HOLD_JOB_LABELS: Record<string, string> = {
  [SECURITY_HOLD_JOB_IDS.workflow_modification]: 'workflow modification',
  [SECURITY_HOLD_JOB_IDS.fork_pr]: 'fork pull request',
  [SECURITY_HOLD_JOB_IDS.unknown_contributor]: 'unknown contributor',
};

const SECURITY_HOLD_JOB_ID_VALUES: ReadonlySet<string> = new Set(
  Object.values(SECURITY_HOLD_JOB_IDS),
);

/**
 * Whether `jobId` is one of the PR-wide security-hold sentinels above.
 *
 * Distinguishes the org trust policy's security hold from every other hold that
 * shares its workflow scope — chiefly the install gate, whose `job_id` is
 * `installGateJobId(workflowName)`. A caller that must act only on the holds the
 * security check run belongs to keys on this rather than on `queue_type`, which
 * an install gate also sets to `security` when its context protection rule is a
 * security hold.
 *
 * It answers about the sentinel vocabulary alone, so a caller applies it to a
 * workflow-scoped hold — where the `job_id` is always a sentinel — rather than
 * to one carrying a real expanded job name.
 */
export function isSecurityHoldJobId(jobId: string): boolean {
  return SECURITY_HOLD_JOB_ID_VALUES.has(jobId);
}

/** Sentinel `job_id` prefix for the workflow install gate, suffixed by the workflow name. */
export const INSTALL_JOB_ID_PREFIX = '__install__';

/** The install-gate sentinel `job_id` for a workflow. */
export function installGateJobId(workflowName: string): string {
  return `${INSTALL_JOB_ID_PREFIX}${workflowName}`;
}
