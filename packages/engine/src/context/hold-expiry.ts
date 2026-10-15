/**
 * Hold window applied when a context carries no explicit hold expiry.
 *
 * `contexts.hold_expiry_seconds` is nullable and has no DDL default; NULL
 * (never set, or cleared) means "no explicit expiry", not "expire instantly".
 * Without this fallback `evaluateReviewerGate` would compute `null * 1000`,
 * put `holdUntil` at the current instant, and the next stale scan would sweep
 * every reviewer hold to `expired`, cancelling the job it gates.
 *
 * Lives beside `DEFAULT_CONCURRENCY_STRATEGY` because the same modules resolve
 * both: the orchestrator's context store, its protection aggregate, and the
 * dispatch path.
 *
 * Plain number, no `node:*` import — safe for the browser-facing engine barrel.
 */
export const DEFAULT_HOLD_EXPIRY_SECONDS = 3600;
