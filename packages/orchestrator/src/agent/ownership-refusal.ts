/**
 * The single refusal wording sent to an agent whose job-scoped frame was not
 * accepted on ownership grounds.
 *
 * Deliberately identical whether the database decided "not owned" or could not
 * decide at all. A caller that could tell the two apart would hold an oracle for
 * job existence, upload-commit state, and orchestrator database health — so the
 * two cases are indistinguishable on the wire, and the distinction lives only in
 * the orchestrator's own logs.
 */
export const OWNERSHIP_REFUSED = 'this job is not owned by this agent';
