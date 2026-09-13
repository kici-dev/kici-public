import { sql, type Kysely, type Transaction } from 'kysely';

import type { Database } from '../db/types.js';
import type { DlqReason, EventRouterConfig, StoredEvent } from './types.js';

/** Either a Kysely DB handle or an active transaction. */
export type DbExecutor = Kysely<Database> | Transaction<Database>;

const LAST_ERROR_MAX_BYTES = 4096;

/**
 * Default page size for unprocessed-event catch-up scans.
 *
 * Shared with EventRouter.catchUp so the paginating loop's "a short batch
 * means we're done" termination check compares against the same value the
 * store slices by.
 */
export const EVENT_CATCHUP_BATCH_SIZE = 100;

/**
 * Input shape for writing a new event. Excludes columns the DB fills in
 * itself (id, processed, created_at, attempts, claimed_*, last_error,
 * next_retry_at, dlq_*).
 */
export interface NewEventInput {
  eventName: string;
  payload: Record<string, unknown>;
  sourceRepo?: string;
  sourceRoutingKey?: string;
  sourceRunId?: string;
  sourceJobId?: string;
  targetRepos?: string[];
  chainDepth: number;
  expiresAt: Date;
}

/**
 * Persists and queries internal events (system + custom).
 *
 * Provides:
 *  - TTL-based cleanup for expired non-DLQ events.
 *  - Lease-based dispatch claim with bounded retries (replaces the prior
 *    "flip processed=true upfront" pattern that silently lost events when
 *    dispatch threw).
 *  - DLQ helpers for surfacing events that exhausted retries.
 */
export class EventStore {
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly config: EventRouterConfig,
  ) {}

  /**
   * Expose the underlying Kysely handle for callers that need to issue
   * `pg_notify` outside of EventStore (e.g. the admin DLQ retry route, which
   * re-publishes after `resetFromDlq` so a healthy node picks the event up
   * before the next retry-scanner tick).
   */
  getDb(): Kysely<Database> {
    return this.db;
  }

  /**
   * Write a new event to the store using the default DB handle.
   * Computes expires_at from the configured TTL.
   * Returns the generated event ID.
   */
  async write(event: NewEventInput): Promise<string> {
    return this.writeWith(event, this.db);
  }

  /**
   * Write a new event using a caller-provided executor (typically a Kysely
   * Transaction). Used by `EventRouter.emitInTx` to atomically combine the
   * insert with other transactional work (e.g. cron `tryClaimFire`).
   */
  async writeWith(event: NewEventInput, executor: DbExecutor): Promise<string> {
    const result = await executor
      .insertInto('kici_events')
      .values({
        event_name: event.eventName,
        payload: JSON.stringify(event.payload),
        source_repo: event.sourceRepo ?? null,
        source_routing_key: event.sourceRoutingKey ?? null,
        source_run_id: event.sourceRunId ?? null,
        source_job_id: event.sourceJobId ?? null,
        target_repos: event.targetRepos ? JSON.stringify(event.targetRepos) : null,
        chain_depth: event.chainDepth,
        expires_at: event.expiresAt,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    return result.id;
  }

  /**
   * Retrieve a single event by ID.
   */
  async getById(id: string): Promise<StoredEvent | null> {
    const row = await this.db
      .selectFrom('kici_events')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row ? this.rowToStoredEvent(row) : null;
  }

  /**
   * Get a page of unprocessed events for catch-up on start.
   *
   * Rows are ordered by a deterministic keyset `(created_at ASC, id ASC)` and
   * exclude processed + DLQ rows. When `sinceId` is null, returns the first
   * page from the oldest event. When `sinceId` is given, returns the page
   * strictly after that event's `(created_at, id)` — a composite cursor so
   * that events sharing the reference event's `created_at` are NOT skipped
   * (a bare `created_at > ref` predicate drops same-timestamp siblings) and a
   * still-unprocessed retrying event at or before the cursor is never
   * re-fetched (which is what makes the caller's pagination loop terminate).
   *
   * The caller advances `sinceId` to the last event of each returned page and
   * re-queries until a page returns fewer than `limit` rows.
   */
  async getUnprocessedSince(
    sinceId: string | null,
    limit: number = EVENT_CATCHUP_BATCH_SIZE,
  ): Promise<StoredEvent[]> {
    let query = this.db
      .selectFrom('kici_events')
      .selectAll()
      .where('processed', '=', false)
      .where('dlq_at', 'is', null)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .limit(limit);

    if (sinceId) {
      // Anchor the keyset cursor on the reference event's created_at. The id
      // half of the cursor is sinceId itself, so we only need created_at here.
      const refEvent = await this.db
        .selectFrom('kici_events')
        .select('created_at')
        .where('id', '=', sinceId)
        .executeTakeFirst();

      if (refEvent) {
        // Postgres row-value comparison: strictly greater than the tuple
        // (ref.created_at, sinceId) under the same (created_at, id) ordering.
        // Includes same-created_at siblings with a larger id; excludes the
        // reference row and everything before it.
        query = query.where(sql<boolean>`(created_at, id) > (${refEvent.created_at}, ${sinceId})`);
      }
    }

    const rows = await query.execute();
    return rows.map((row) => this.rowToStoredEvent(row));
  }

  /**
   * Mark an event as fully processed. Called after a successful dispatch.
   * Clears any prior lease so the row is unambiguously terminal.
   */
  async markProcessed(id: string): Promise<void> {
    await this.db
      .updateTable('kici_events')
      .set({ processed: true, claimed_at: null, claimed_by: null })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Atomically take a dispatch lease on an event. Replaces the previous
   * "flip processed=true upfront" pattern that silently lost events when
   * dispatch threw after the flip.
   *
   * The UPDATE succeeds when:
   *  - the event is not yet processed and not in DLQ, AND
   *  - either no lease is held, OR the existing lease has expired.
   *
   * On success: sets `claimed_at = NOW()`, `claimed_by = $leaseHolder`,
   * increments `attempts`. The caller must subsequently call `markProcessed`
   * (success), `recordDispatchFailure` (failure with retry), or `markDlq`
   * (terminal failure) — otherwise the lease times out after
   * `leaseDurationMs` and the leader-only retry scanner releases it.
   *
   * Returns the leased event row, or null if the event was already
   * processed/leased/DLQ'd.
   */
  async tryLeaseForProcessing(id: string, leaseHolder: string): Promise<StoredEvent | null> {
    const leaseDurationMs = this.config.leaseDurationMs;
    const row = await this.db
      .updateTable('kici_events')
      .set({
        claimed_at: sql<Date>`NOW()`,
        claimed_by: leaseHolder,
        attempts: sql<number>`attempts + 1`,
      })
      .where('id', '=', id)
      .where('processed', '=', false)
      .where('dlq_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb('claimed_at', 'is', null),
          eb(
            'claimed_at',
            '<',
            sql<Date>`NOW() - (${leaseDurationMs} || ' milliseconds')::interval`,
          ),
        ]),
      )
      .returningAll()
      .executeTakeFirst();

    return row ? this.rowToStoredEvent(row) : null;
  }

  /**
   * Record a failed dispatch attempt. Releases the lease, stores the
   * (truncated) error, and schedules the next retry. The leader-only
   * retry scanner will re-publish `pg_notify` for this event when
   * `next_retry_at <= NOW()`.
   */
  async recordDispatchFailure(id: string, errorMessage: string, nextRetryAt: Date): Promise<void> {
    await this.db
      .updateTable('kici_events')
      .set({
        claimed_at: null,
        claimed_by: null,
        last_error: truncateError(errorMessage),
        next_retry_at: nextRetryAt,
      })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Mark an event as DLQ. Sets `processed=true` so it stops being eligible
   * for retry, records `dlq_at` + `dlq_reason`, and preserves `last_error`
   * (overwritten if a fresh error message is provided).
   */
  async markDlq(id: string, reason: DlqReason, errorMessage?: string): Promise<void> {
    const update: Record<string, unknown> = {
      processed: true,
      claimed_at: null,
      claimed_by: null,
      dlq_at: sql<Date>`NOW()`,
      dlq_reason: reason,
    };
    if (errorMessage !== undefined) {
      update.last_error = truncateError(errorMessage);
    }
    await this.db.updateTable('kici_events').set(update).where('id', '=', id).execute();
  }

  /**
   * Find events whose `next_retry_at` is due. The leader-only retry scanner
   * uses this to know which events to re-publish via `pg_notify`.
   */
  async findEventsDueForRetry(limit: number): Promise<StoredEvent[]> {
    const rows = await this.db
      .selectFrom('kici_events')
      .selectAll()
      .where('processed', '=', false)
      .where('dlq_at', 'is', null)
      .where('next_retry_at', 'is not', null)
      .where('next_retry_at', '<=', sql<Date>`NOW()`)
      .orderBy('next_retry_at', 'asc')
      .limit(limit)
      .execute();
    return rows.map((row) => this.rowToStoredEvent(row));
  }

  /**
   * Find events whose lease has expired. The leader-only scanner releases
   * these (clears `claimed_at` + sets `next_retry_at = NOW()`) and then
   * re-publishes `pg_notify` so a healthy node picks them up.
   */
  async findExpiredLeases(limit: number): Promise<StoredEvent[]> {
    const leaseDurationMs = this.config.leaseDurationMs;
    const rows = await this.db
      .selectFrom('kici_events')
      .selectAll()
      .where('processed', '=', false)
      .where('dlq_at', 'is', null)
      .where('claimed_at', 'is not', null)
      .where(
        'claimed_at',
        '<',
        sql<Date>`NOW() - (${leaseDurationMs} || ' milliseconds')::interval`,
      )
      .orderBy('claimed_at', 'asc')
      .limit(limit)
      .execute();
    return rows.map((row) => this.rowToStoredEvent(row));
  }

  /**
   * Release an expired lease so the event is once again eligible for
   * `tryLeaseForProcessing`. Used by the retry scanner together with a
   * `pg_notify` re-publication.
   */
  async releaseExpiredLease(id: string): Promise<void> {
    await this.db
      .updateTable('kici_events')
      .set({
        claimed_at: null,
        claimed_by: null,
        next_retry_at: sql<Date>`NOW()`,
        last_error: 'lease expired (dispatch node died or hung)',
      })
      .where('id', '=', id)
      .where('processed', '=', false)
      .where('dlq_at', 'is', null)
      .execute();
  }

  /**
   * List events currently in the DLQ. Most recent first. Used by the
   * dashboard admin DLQ page.
   *
   * @param sourceRoutingKey - When provided, restrict the result to
   *   events whose `source_routing_key` matches. Used by routing-key
   *   -scoped admin tokens so the operator only sees their slice.
   */
  async listDlq(
    limit: number,
    beforeDlqAt?: Date,
    sourceRoutingKey?: string,
  ): Promise<StoredEvent[]> {
    let q = this.db
      .selectFrom('kici_events')
      .selectAll()
      .where('dlq_at', 'is not', null)
      .orderBy('dlq_at', 'desc')
      .limit(limit);
    if (beforeDlqAt !== undefined) {
      q = q.where('dlq_at', '<', beforeDlqAt);
    }
    if (sourceRoutingKey !== undefined) {
      q = q.where('source_routing_key', '=', sourceRoutingKey);
    }
    const rows = await q.execute();
    return rows.map((row) => this.rowToStoredEvent(row));
  }

  /**
   * Count events currently in the DLQ. Used by the dashboard summary row
   * and the `kici_orch_event_dlq_depth` gauge.
   *
   * @param sourceRoutingKey - When provided, restrict the count to
   *   events whose `source_routing_key` matches.
   */
  async countDlq(sourceRoutingKey?: string): Promise<number> {
    let q = this.db
      .selectFrom('kici_events')
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .where('dlq_at', 'is not', null);
    if (sourceRoutingKey !== undefined) {
      q = q.where('source_routing_key', '=', sourceRoutingKey);
    }
    const result = await q.executeTakeFirstOrThrow();
    return parseInt(result.count, 10);
  }

  /**
   * Reset a DLQ event so it gets retried on the next scanner tick. Used by
   * the dashboard "Retry" action.
   */
  async resetFromDlq(id: string): Promise<boolean> {
    const result = await this.db
      .updateTable('kici_events')
      .set({
        processed: false,
        dlq_at: null,
        dlq_reason: null,
        claimed_at: null,
        claimed_by: null,
        attempts: 0,
        next_retry_at: sql<Date>`NOW()`,
      })
      .where('id', '=', id)
      .where('dlq_at', 'is not', null)
      .executeTakeFirst();
    return BigInt(result.numUpdatedRows ?? 0n) > 0n;
  }

  /**
   * Permanently delete a DLQ event. Used by the dashboard "Discard" action.
   */
  async deleteDlq(id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('kici_events')
      .where('id', '=', id)
      .where('dlq_at', 'is not', null)
      .executeTakeFirst();
    return BigInt(result.numDeletedRows ?? 0n) > 0n;
  }

  /**
   * Delete expired events. Returns the count of deleted rows. DLQ rows are
   * preserved so operators have time to triage them.
   */
  async cleanup(): Promise<number> {
    const result = await sql<{ count: string }>`
      WITH deleted AS (
        DELETE FROM kici_events
        WHERE expires_at < NOW()
          AND dlq_at IS NULL
        RETURNING id
      )
      SELECT count(*)::text AS count FROM deleted
    `.execute(this.db);

    return parseInt(result.rows[0]?.count ?? '0', 10);
  }

  /**
   * Start periodic cleanup using setInterval.
   */
  startCleanupTimer(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      this.cleanup().catch(() => {
        // Silently ignore cleanup errors -- will retry on next interval
      });
    }, this.config.cleanupIntervalMs);
    // Allow process to exit even if timer is running
    this.cleanupTimer.unref();
  }

  /**
   * Stop periodic cleanup.
   */
  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Convert a DB row to a StoredEvent.
   */
  private rowToStoredEvent(row: {
    id: string;
    event_name: string;
    payload: string;
    source_repo: string | null;
    source_routing_key: string | null;
    source_run_id: string | null;
    source_job_id: string | null;
    target_repos: string | null;
    chain_depth: number;
    processed: boolean;
    created_at: Date;
    expires_at: Date;
    claimed_at: Date | null;
    claimed_by: string | null;
    attempts: number;
    last_error: string | null;
    next_retry_at: Date | null;
    dlq_at: Date | null;
    dlq_reason: string | null;
  }): StoredEvent {
    const targetRepos = row.target_repos
      ? typeof row.target_repos === 'string'
        ? (JSON.parse(row.target_repos) as string[])
        : (row.target_repos as unknown as string[])
      : undefined;

    return {
      id: row.id,
      eventName: row.event_name,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      sourceRepo: row.source_repo ?? undefined,
      sourceRoutingKey: row.source_routing_key ?? undefined,
      sourceRunId: row.source_run_id ?? undefined,
      sourceJobId: row.source_job_id ?? undefined,
      targetRepos,
      chainDepth: row.chain_depth,
      processed: row.processed,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      claimedAt: row.claimed_at,
      claimedBy: row.claimed_by,
      attempts: row.attempts,
      lastError: row.last_error,
      nextRetryAt: row.next_retry_at,
      dlqAt: row.dlq_at,
      dlqReason: row.dlq_reason as DlqReason | null,
    };
  }
}

function truncateError(message: string): string {
  if (Buffer.byteLength(message, 'utf8') <= LAST_ERROR_MAX_BYTES) return message;
  // Truncate by characters from the front (most informative); cheaper than
  // a precise byte truncation and still bounded.
  return message.slice(0, LAST_ERROR_MAX_BYTES) + '...[truncated]';
}
