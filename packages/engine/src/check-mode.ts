import { z } from 'zod';

/**
 * How a run executes idempotent steps.
 *
 * - `apply` (default): converge — per step, check(); on drift apply(); else in sync.
 * - `check`: report what would change, changing nothing (always succeeds; report-only).
 * - `check-fail-on-drift`: like check, but the run fails if any step reports drift.
 */
export const CheckMode = z.enum(['apply', 'check', 'check-fail-on-drift']);
export type CheckMode = z.infer<typeof CheckMode>;

/**
 * Per-step idempotent outcome. The first four mirror the StepOutcome union in
 * @kici-dev/core/idempotency verbatim (skipped | applied | declined | dry-run);
 * `no_check` covers a plain step (no check facet) skipped under check mode
 * because it cannot be safely previewed.
 *
 * Orthogonal to ExecutionStepStatus (success | failed | skipped), which stays the
 * top-level status. Dashboard chips map: applied -> "applied", skipped -> "in sync",
 * dry-run -> "would change", no_check -> "no check".
 */
export const CheckStepOutcome = z.enum(['skipped', 'applied', 'declined', 'dry-run', 'no_check']);
export type CheckStepOutcome = z.infer<typeof CheckStepOutcome>;
