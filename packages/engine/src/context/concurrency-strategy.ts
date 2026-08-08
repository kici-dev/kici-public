import { z } from 'zod';

/**
 * What a context does with a run that arrives while its concurrency limit is
 * saturated. Single source of truth shared by the dashboard protection form, the
 * context domain type, the orchestrator's context store and protection
 * aggregate, and the concurrency gate.
 *
 * - `queue` — hold the run until a slot frees. The strategy applied when a
 *   context sets a limit but no explicit strategy.
 * - `cancel-pending` — drop the already-waiting run in favour of the new one.
 *
 * Not to be confused with the protection gates' `action` vocabulary
 * (`'hold' | 'wait' | 'queue'` on `ProtectionGateResult`), which shares the
 * `queue` spelling and means something else entirely.
 *
 * The orchestrator's `contexts.concurrency_strategy` column stays typed as
 * `string` so a row written by a different orchestrator version never fails to
 * map; this enum is the vocabulary every writer validates against.
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
