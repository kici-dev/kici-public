import { z } from 'zod';

/**
 * What a context does with a run that arrives while its concurrency limit is
 * saturated. Shared by the dashboard protection form, the context domain type,
 * the orchestrator's context store and protection aggregate, and the
 * concurrency gate.
 *
 * - `queue` — hold the run until a slot frees. The default strategy.
 * - `cancel-pending` — drop the already-waiting run in favour of the new one.
 *
 * Unrelated to the `queue` in the protection gates' `action` vocabulary
 * (`'hold' | 'wait' | 'queue'` on `ProtectionGateResult`).
 *
 * The orchestrator's `contexts.concurrency_strategy` column stays `string` so a
 * row written by a different orchestrator version always maps; every writer
 * validates against this enum.
 *
 * Pure Zod, no `node:*` imports — safe for the browser-facing engine barrel.
 */
export const ConcurrencyStrategy = z.enum(['queue', 'cancel-pending']);
export type ConcurrencyStrategy = z.infer<typeof ConcurrencyStrategy>;

/**
 * The strategy applied when a context carries an effective concurrency limit but
 * no explicit strategy. Lives beside the enum so the dashboard form and the
 * orchestrator aggregate cannot pick different defaults — a mismatch reads as a
 * permanently dirty protection form.
 */
export const DEFAULT_CONCURRENCY_STRATEGY: ConcurrencyStrategy = ConcurrencyStrategy.enum.queue;
