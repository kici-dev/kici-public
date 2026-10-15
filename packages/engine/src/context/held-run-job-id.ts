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
 * render a row label; sharing them here means a rename on the writer cannot
 * silently stop the reader from recognising the sentinel.
 */

/** Sentinel `job_id` for the PR-wide workflow-modification security hold. */
export const WORKFLOW_MODIFICATION_JOB_ID = '__workflow_modification__';

/**
 * Sentinel `job_id` per PR-wide security-hold reason, written when the org
 * trust policy holds a run.
 *
 * Values never change, so a hold written by any earlier build still resolves.
 * The policy raises only `fork_pr` now; the other two stay so the dashboard can
 * label rows written when it had more arms.
 *
 * `context_trust` is deliberately absent: the per-context minimum-trust gate
 * writes the real expanded job name so the operator can approve that job
 * specifically, so a sentinel for it would be a value nothing writes.
 *
 * The key set is asserted against the orchestrator's security-hold reasons in
 * the orchestrator's own test (the engine must not depend on the orchestrator).
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
 * shares its workflow scope, chiefly the install gate
 * (`installGateJobId(workflowName)`). Key on this, not on `queue_type`: an
 * install gate also sets `security` there when its context protection rule is
 * a security hold.
 *
 * It checks the sentinel vocabulary alone, so apply it to a workflow-scoped
 * hold (whose `job_id` is always a sentinel), not one carrying a real job name.
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
