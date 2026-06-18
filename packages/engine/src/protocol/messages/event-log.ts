import { z } from 'zod';

// --- Inbound webhook delivery log enums (single source of truth via Zod z.enum) ---
// Access values: EventLogStatus.enum.processed, PayloadOmittedReason.enum.size_exceeded.
// These enums back the orchestrator `event_log` table, the dashboard list/detail
// projections, and the kici-admin `event-log` CLI. They are NOT used for the
// Platform-side `event_log` (which uses a separate, narrower 'pending' default
// status — Platform owns the routing-status string).

/**
 * Outcome of webhook processing on the orchestrator.
 *
 * - `received` — row written before processing started (e.g. oversized payload
 *   path that records the row but defers further work to the standard pipeline).
 * - `processed` — webhook was processed and at least one workflow was
 *   evaluated. `matched_count` carries how many actually matched.
 * - `duplicate` — dedup cache rejected the delivery.
 * - `lockfile_missing` — repo lookup succeeded but no lock file was found
 *   (and no global workflows matched either).
 * - `lockfile_corrupt` — a lock file was present at the repo ref but could not
 *   be parsed or validated; the orchestrator records a `lock_resolution`
 *   init-failure run for the delivery.
 * - `failed` — pipeline threw an unhandled error. `error_message` carries
 *   the message.
 */
export const EventLogStatus = z.enum([
  'received',
  'processed',
  'duplicate',
  'lockfile_missing',
  'lockfile_corrupt',
  'failed',
]);
export type EventLogStatus = z.infer<typeof EventLogStatus>;

/**
 * Reason the payload was NOT stored to object storage.
 *
 * - `size_exceeded` — body exceeded the configured `eventLog.maxPayloadBytes`
 *   soft cap. The DB row is still written (with the hash + actual size) so the
 *   delivery is visible in the dashboard; the body itself can be retrieved
 *   from `KICI_WEBHOOK_PAYLOAD_DIR` or raw logs by hash if needed.
 * - `storage_failed` — upload to LogStorage threw. The DB row is still
 *   written so the operator can investigate; the failure is logged at error
 *   level by the writer.
 */
export const PayloadOmittedReason = z.enum(['size_exceeded', 'storage_failed']);
export type PayloadOmittedReason = z.infer<typeof PayloadOmittedReason>;

/**
 * Where the webhook arrived.
 * - `relay` — Platform-Orchestrator WS relay path.
 * - `direct` — Direct HTTP ingress (independent / hybrid mode).
 */
export const EventLogSource = z.enum(['relay', 'direct']);
export type EventLogSource = z.infer<typeof EventLogSource>;
