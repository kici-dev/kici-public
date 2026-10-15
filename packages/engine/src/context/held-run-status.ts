/**
 * Held-run status vocabulary.
 *
 * Lives beside `hold-type.ts` and `concurrency-strategy.ts` rather than in the
 * protocol module, so the domain types and the wire schema in
 * `protocol/messages/dashboard.ts` name one enum. A separate copy drifts: a
 * status the orchestrator persists goes missing from the wire schema.
 *
 * This is the *known* vocabulary: the statuses the dashboard renders a labelled
 * badge and a queue tab for, and a client may filter a list by. It is NOT the
 * wire type of the response field: `held_runs.status` is a plain-text column
 * owned by a customer-deployed orchestrator, so the response carries
 * `z.string()`.
 */
import { z } from 'zod';

/**
 * Known held-run statuses. The orchestrator's `releaseDueWaitHolds()` writes
 * `released` when a workflow-scope wait timer elapses and the run proceeds.
 */
export const HeldRunStatus = z.enum(['pending', 'approved', 'rejected', 'expired', 'released']);
export type HeldRunStatus = z.infer<typeof HeldRunStatus>;
