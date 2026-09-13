/**
 * Held-run status vocabulary — the single definition of what a held run's
 * `status` can be.
 *
 * Lives beside `hold-type.ts` and `concurrency-strategy.ts` (the other shared
 * context vocabularies) rather than in the protocol module, so both the domain
 * types here and the wire schema in `protocol/messages/dashboard.ts` name the
 * same enum instead of each carrying its own copy. A duplicated copy is exactly
 * how `released` came to be persisted by the orchestrator but absent from the
 * wire schema.
 *
 * This is the *known* vocabulary — the set the dashboard renders a labelled
 * badge and a queue tab for, and the set a client may filter a list by. It is
 * deliberately NOT the wire type of the response field: `held_runs.status` is a
 * plain-text column owned by a customer-deployed orchestrator, so the response
 * carries `z.string()`.
 */
import { z } from 'zod';

/**
 * Known held-run statuses.
 *
 * `released` is written by the orchestrator's `releaseDueWaitHolds()` when a
 * workflow-scope wait timer elapses and the run proceeds.
 */
export const HeldRunStatus = z.enum(['pending', 'approved', 'rejected', 'expired', 'released']);
export type HeldRunStatus = z.infer<typeof HeldRunStatus>;
