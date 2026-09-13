/**
 * Hold window applied when a context carries no explicit hold expiry.
 *
 * `contexts.hold_expiry_seconds` is nullable, and a cleared column means "no
 * explicit expiry" rather than "expire instantly" — without this fallback a
 * cleared value would reach `evaluateReviewerGate` as `null`, whose
 * `null * 1000` puts `holdUntil` at the current instant, so every reviewer hold
 * would be created already overdue and swept to `expired` on the next stale
 * scan, cancelling the job the hold was meant to gate.
 *
 * It lives here, beside `DEFAULT_CONCURRENCY_STRATEGY`, because the same three
 * modules resolve both: the orchestrator's context store, its protection
 * aggregate, and the dispatch path. The column carries no DDL default, so a
 * context created without a hold expiry and one whose expiry was cleared both
 * land on NULL and resolve through this single constant.
 *
 * Plain number, no `node:*` import — safe for the browser-facing engine barrel.
 */
export const DEFAULT_HOLD_EXPIRY_SECONDS = 3600;
