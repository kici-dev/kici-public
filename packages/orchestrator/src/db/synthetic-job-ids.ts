/**
 * The `execution_jobs.job_id` prefix that marks a PLACEHOLDER row.
 *
 * A placeholder stands for a job the dispatch pass registered but did not hand
 * to the dispatcher — one waiting on a `needs` edge, on a rolling-wave slot, on
 * an invoke-gate summon, or on a protection-rule hold. It exists so the run is
 * not considered complete without it (`isRunComplete` iterates only registered
 * jobs), and it is swapped for the real job id the moment the job actually
 * dispatches (`dispatchReadyJob` → `findSyntheticJobId` → `addJobsToRun`).
 *
 * Lives here, beside the table it describes, because both the writers
 * (`pipeline/`) and the readers that must exclude these rows from an occupancy
 * count (`contexts/`) key on it, and neither layer imports the other.
 */
export const NEEDS_PENDING_JOB_ID_PREFIX = 'needs-pending-';

/**
 * SQL `LIKE` pattern matching every placeholder `job_id`.
 *
 * `_` is a single-character wildcard in `LIKE`, so the literal underscore-free
 * prefix above needs no escaping — kept as one constant anyway so a caller can
 * never spell the pattern and the prefix differently.
 */
export const NEEDS_PENDING_JOB_ID_LIKE = `${NEEDS_PENDING_JOB_ID_PREFIX}%`;
