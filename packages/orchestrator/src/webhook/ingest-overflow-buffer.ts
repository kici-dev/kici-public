import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import {
  OverflowStatus,
  OverflowDropReason,
  type OverflowDelivery,
} from './ingest-overflow-types.js';
import {
  ingestOverflowCapturedTotal,
  ingestOverflowDroppedTotal,
  setIngestOverflowBuffered,
} from '../metrics/prometheus.js';

export interface IngestOverflowBufferDeps {
  db: Kysely<Database>;
  /** Buffered-row cap (KICI_INGEST_OVERFLOW_MAX). */
  maxRows: number;
}

/**
 * Capture side of the durable ingest queue. Two feeders write rows here.
 *
 * The **accept** path (HTTP direct ingress) enqueues every admitted delivery
 * before the route answers 202: the row is what makes "durably queued" true, so
 * a worker that dies mid-pipeline leaves recoverable work behind rather than a
 * delivery the sender believes was accepted.
 *
 * The **shed** path enqueues additively when the admission controller rejects a
 * delivery (the 429 still stands), so capacity recovering is enough to get the
 * delivery processed without the sender redelivering.
 *
 * At the row cap, an enqueue fails rather than growing the table without bound.
 * The two feeders differ in what that means: a shed delivery is dropped (the
 * lossy fallback a retrying sender still covers), while the accept path must
 * NOT answer 202 for a delivery it did not store — it sheds instead, so the
 * sender learns the delivery was refused.
 */
export class IngestOverflowBuffer {
  private readonly db: Kysely<Database>;
  private readonly maxRows: number;

  constructor(deps: IngestOverflowBufferDeps) {
    this.db = deps.db;
    this.maxRows = deps.maxRows;
  }

  /** Current buffered-row depth. */
  async currentDepth(): Promise<number> {
    const row = await this.db
      .selectFrom('ingest_overflow_buffer')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('status', '=', OverflowStatus.enum.buffered)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  /**
   * Persist a delivery as `buffered` and return its row id, or null when the
   * buffer is at cap. Callers that must not acknowledge an unstored delivery
   * check for null; the shed path treats null as a drop.
   */
  async enqueue(d: OverflowDelivery): Promise<number | null> {
    const depth = await this.currentDepth();
    if (depth >= this.maxRows) {
      ingestOverflowDroppedTotal.add(1, { reason: OverflowDropReason.enum.cap_full });
      return null;
    }

    const inserted = await this.db
      .insertInto('ingest_overflow_buffer')
      .values({
        delivery_id: d.deliveryId,
        routing_key: d.routingKey,
        source_kind: d.sourceKind,
        provider: d.provider,
        event: d.event,
        action: d.action,
        body: d.body,
        meta: JSON.stringify(d.meta) as unknown as Record<string, unknown>,
        status: OverflowStatus.enum.buffered,
      })
      .returning('id')
      .executeTakeFirst();

    ingestOverflowCapturedTotal.add(1);
    setIngestOverflowBuffered(depth + 1);
    return inserted ? Number(inserted.id) : null;
  }

  /**
   * Persist a shed delivery. Returns true when a `buffered` row was inserted,
   * false when the buffer is at cap (delivery dropped, `cap_full` metric bumped).
   */
  async capture(d: OverflowDelivery): Promise<boolean> {
    return (await this.enqueue(d)) !== null;
  }

  /**
   * Claim a specific row for processing: `buffered` → `replaying`, stamping the
   * claim clock. Returns false when someone else already owns it — a drain pass
   * on another instance, or a reclaim that ran while this caller was scheduling.
   * The conditional update is the arbiter, so two workers can never both own a
   * row and dispatch its delivery twice.
   */
  async claimRow(id: number): Promise<boolean> {
    const res = await this.db
      .updateTable('ingest_overflow_buffer')
      .set({ status: OverflowStatus.enum.replaying, claimed_at: new Date() })
      .where('id', '=', id)
      .where('status', '=', OverflowStatus.enum.buffered)
      .executeTakeFirst();
    return Number(res.numUpdatedRows ?? 0n) > 0;
  }

  /**
   * Mark a claimed row done. The row is swept by the drain pass rather than
   * deleted here, so the sweep stays the single deletion site.
   */
  async markProcessed(id: number): Promise<void> {
    await this.db
      .updateTable('ingest_overflow_buffer')
      .set({ status: OverflowStatus.enum.replayed, last_error: null })
      .where('id', '=', id)
      .execute();
  }
}
