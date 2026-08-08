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
 * Capture side of the durable overflow buffer. On a shed, the ingest path calls
 * {@link IngestOverflowBuffer.capture} additively (the 429 still stands). At the
 * row cap, capture drops the delivery from the buffer (never unbounded rows) —
 * the lossy fallback a retrying sender still covers.
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
   * Persist a shed delivery. Returns true when a `buffered` row was inserted,
   * false when the buffer is at cap (delivery dropped, `cap_full` metric bumped).
   */
  async capture(d: OverflowDelivery): Promise<boolean> {
    const depth = await this.currentDepth();
    if (depth >= this.maxRows) {
      ingestOverflowDroppedTotal.add(1, { reason: OverflowDropReason.enum.cap_full });
      return false;
    }

    await this.db
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
      .execute();

    ingestOverflowCapturedTotal.add(1);
    setIngestOverflowBuffered(depth + 1);
    return true;
  }
}
