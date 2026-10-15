/**
 * The single refusal wording sent to an agent whose job-scoped frame was not
 * accepted on ownership grounds.
 *
 * Identical whether the database decided "not owned" or could not decide:
 * telling them apart would be an oracle for job existence, upload-commit state
 * and database health, so the distinction lives only in the orchestrator logs.
 */
export const OWNERSHIP_REFUSED = 'this job is not owned by this agent';
