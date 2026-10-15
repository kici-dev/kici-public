import { z } from 'zod';

// --- Inbound webhook delivery log enums ---
// They back the orchestrator `event_log` table, the dashboard list/detail
// projections and the kici-admin `event-log` CLI, not the Platform-side
// `event_log`, whose narrower 'pending'-default routing status Platform owns.

/**
 * Outcome of webhook processing on the orchestrator.
 *
 * - `received` — row written before processing started (e.g. the oversized
 *   payload path, which defers further work to the standard pipeline).
 * - `shed` — the ingest admission controller refused the delivery under load
 *   before the pipeline; `error_message` names the reason. The row tells a
 *   shed delivery apart from one that never arrived, and a later successful
 *   overflow replay upgrades it to its real outcome.
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
  'shed',
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
 * - `size_exceeded` — body exceeded the `eventLog.maxPayloadBytes` soft cap.
 *   The DB row (hash + actual size) is still written, so the delivery shows in
 *   the dashboard; the body is retrievable by hash from
 *   `KICI_WEBHOOK_PAYLOAD_DIR` or raw logs.
 * - `storage_failed` — upload to LogStorage threw. The DB row is still
 *   written, and the writer logs the failure at error level.
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
