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
 * Lives here because the writers (`pipeline/`) and the readers that exclude
 * these rows from an occupancy count (`contexts/`) both key on it, and neither
 * layer imports the other.
 */
export const NEEDS_PENDING_JOB_ID_PREFIX = 'needs-pending-';

/**
 * SQL `LIKE` pattern matching every placeholder `job_id`. The prefix has no
 * `_` wildcard, so it needs no escaping; one constant keeps a caller from
 * spelling the pattern and the prefix differently.
 */
export const NEEDS_PENDING_JOB_ID_LIKE = `${NEEDS_PENDING_JOB_ID_PREFIX}%`;
