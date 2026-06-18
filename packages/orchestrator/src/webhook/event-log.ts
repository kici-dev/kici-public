/**
 * EventLogWriter — orchestrator-side recorder for inbound webhook deliveries.
 *
 * Mirrors the Platform-side `event_log` writer: every inbound webhook
 * delivery (relay or direct) generates one row keyed by `(org_id, delivery_id)`.
 * Rows from both tiers join on this composite key so the dashboard can
 * present a unified per-delivery projection.
 *
 * What this module owns:
 *   - Computing the SHA-256 payload hash with the SAME algorithm as Platform
 *     (`sha256()` from `@kici-dev/shared`) so the cross-tier join works.
 *   - Gzipping + uploading the payload to LogStorage at
 *     `event-log/<orgId>/<deliveryId>.json.gz`.
 *   - Enforcing the soft cap (`eventLog.maxPayloadBytes`): oversized payloads
 *     are STILL recorded with `payload_omitted=true`,
 *     `payload_omitted_reason='size_exceeded'`, and the actual byte size +
 *     hash so operators can correlate against raw logs.
 *   - Tolerating object-storage failures: the row is written with
 *     `payload_omitted=true`, reason `'storage_failed'`. No DB fallback for
 *     the body — single read path keeps the detail handler simple.
 *   - Idempotent upsert keyed by `(org_id, delivery_id)`. Duplicate replays
 *     bump `status` / `run_id` / `matched_count` / `error_message` rather
 *     than throwing on the unique constraint, so the duplicate webhook path
 *     can record an outcome row without conflicting with the first delivery.
 */
import { gzipSync } from 'node:zlib';
import { createLogger, encodeKeySegment, sha256, toErrorMessage } from '@kici-dev/shared';
import { EventLogStatus, PayloadOmittedReason, EventLogSource } from '@kici-dev/engine';
import type { Kysely } from 'kysely';
import type { Database, NewEventLogRow } from '../db/types.js';
import type { LogStorage } from '../reporting/log-storage.js';
import type { WebhookInfo } from './handler.js';

const logger = createLogger({ prefix: 'event-log' });

/** Configuration for the writer. */
export interface EventLogWriterOptions {
  /** Soft cap in bytes for payload upload (default 5 MB). */
  maxPayloadBytes: number;
}

/**
 * Outcome metadata recorded alongside the delivery row.
 *
 * Most fields are optional and default to safe values — callers in the early
 * branches (duplicate, dedup) only know the routing-level metadata; later
 * branches (processed, lockfile_missing, failed) carry richer outcome data.
 */
export interface EventLogOutcome {
  /** Resolved tenant ID. Required (the table is org-scoped). */
  orgId: string;
  /** Where the delivery arrived. */
  source: EventLogSource;
  /** Outcome status. */
  status: EventLogStatus;
  /** Workflows matched by trigger evaluation (default 0). */
  matchedCount?: number;
  /** owner/repo extracted from payload (when available). */
  repoIdentifier?: string | null;
  /** Best-effort ref/branch (when extractable). */
  ref?: string | null;
  /** First run spawned by this delivery. */
  runId?: string | null;
  /** Failure reason when status='failed'. */
  errorMessage?: string | null;
}

/**
 * Pre-computed payload representation. Letting callers serialize once and
 * pass both the bytes and the JSON shape avoids double-stringify in the
 * hot path. The writer hashes the bytes, gzips them, and uploads.
 */
export interface PayloadBytes {
  /** UTF-8 encoded raw body bytes (what Platform hashed). */
  raw: Buffer;
}

/**
 * Build a `PayloadBytes` from the parsed webhook payload object. Uses
 * `JSON.stringify` with no formatting — same shape Platform uses to compute
 * its hash on the relay path (Platform actually hashes the inbound HTTP body
 * directly; for relay-replayed webhooks the orchestrator only ever sees the
 * parsed object, so we re-stringify deterministically and hash that).
 *
 * For DIRECT ingress paths (orchestrator HTTP endpoint) callers SHOULD pass
 * the raw HTTP body buffer instead — that matches Platform's hash byte-for-
 * byte for the same delivery in mixed-mode setups.
 */
export function payloadFromObject(payload: unknown): PayloadBytes {
  return { raw: Buffer.from(JSON.stringify(payload), 'utf-8') };
}

/**
 * Build a `PayloadBytes` from a raw HTTP body string (direct ingress).
 */
export function payloadFromRawBody(body: string): PayloadBytes {
  return { raw: Buffer.from(body, 'utf-8') };
}

export class EventLogWriter {
  private readonly db: Kysely<Database>;
  private readonly logStorage: LogStorage;
  private readonly opts: EventLogWriterOptions;

  constructor(db: Kysely<Database>, logStorage: LogStorage, opts: EventLogWriterOptions) {
    this.db = db;
    this.logStorage = logStorage;
    this.opts = opts;
  }

  /**
   * Build the canonical object-storage key for a delivery's payload.
   * Exposed so the cleanup job can compute keys for deletion without
   * calling back into the writer instance.
   */
  static payloadKey(orgId: string, deliveryId: string): string {
    return `event-log/${orgId}/${encodeKeySegment(deliveryId)}.json.gz`;
  }

  /**
   * Record a delivery outcome.
   *
   * Idempotent on `(org_id, delivery_id)`: if a row already exists (e.g. the
   * pipeline already wrote a `received` row before this `processed` follow-up),
   * the existing row is updated with the new outcome metadata. The
   * payload_key / hash / size fields are NOT overwritten on update — those
   * come from the original delivery's body.
   */
  async record(info: WebhookInfo, payload: PayloadBytes, outcome: EventLogOutcome): Promise<void> {
    const sizeBytes = payload.raw.byteLength;
    const hash = sha256(payload.raw);

    // Decide payload-storage path
    let payloadKey: string | null = null;
    let payloadOmitted = false;
    let payloadOmittedReason: PayloadOmittedReason | null = null;

    if (sizeBytes > this.opts.maxPayloadBytes) {
      payloadOmitted = true;
      payloadOmittedReason = PayloadOmittedReason.enum.size_exceeded;
      logger.warn('Webhook payload exceeds soft cap; recording metadata only', {
        deliveryId: info.deliveryId,
        sizeBytes,
        maxBytes: this.opts.maxPayloadBytes,
      });
    } else {
      const key = EventLogWriter.payloadKey(outcome.orgId, info.deliveryId);
      try {
        const gz = gzipSync(payload.raw);
        // LogStorage.append() creates the file if missing. Single-shot writes
        // (one delivery -> one object) make append() effectively a write.
        await this.logStorage.append(key, gz.toString('binary'));
        payloadKey = key;
      } catch (err) {
        payloadOmitted = true;
        payloadOmittedReason = PayloadOmittedReason.enum.storage_failed;
        logger.error('Failed to upload event-log payload to object storage', {
          deliveryId: info.deliveryId,
          orgId: outcome.orgId,
          error: toErrorMessage(err),
        });
      }
    }

    const row: NewEventLogRow = {
      org_id: outcome.orgId,
      delivery_id: info.deliveryId,
      routing_key: info.routingKey,
      event: info.event,
      action: info.action ?? null,
      source: outcome.source,
      provider: info.provider,
      repo_identifier: outcome.repoIdentifier ?? null,
      ref: outcome.ref ?? null,
      payload_key: payloadKey,
      payload_omitted: payloadOmitted,
      payload_omitted_reason: payloadOmittedReason,
      payload_size_bytes: sizeBytes,
      payload_hash: hash,
      matched_count: outcome.matchedCount ?? 0,
      status: outcome.status,
      run_id: outcome.runId ?? null,
      error_message: outcome.errorMessage ?? null,
      // received_at uses the DB default (now()).
    };

    try {
      await this.db
        .insertInto('event_log')
        .values(row)
        .onConflict((oc) =>
          oc
            .columns(['org_id', 'delivery_id'])
            // Update the OUTCOME fields only. Body-derived fields
            // (payload_key, payload_omitted, payload_size_bytes, payload_hash)
            // are NOT overwritten — they belong to the first delivery's body.
            // routing_key / event / action / source / provider are also
            // body-derived and immutable for the same delivery_id.
            .doUpdateSet({
              status: row.status,
              run_id: row.run_id,
              matched_count: row.matched_count,
              error_message: row.error_message,
              repo_identifier: row.repo_identifier,
              ref: row.ref,
            }),
        )
        .execute();
    } catch (err) {
      logger.error('Failed to record event_log row', {
        deliveryId: info.deliveryId,
        orgId: outcome.orgId,
        error: toErrorMessage(err),
      });
    }
  }
}
