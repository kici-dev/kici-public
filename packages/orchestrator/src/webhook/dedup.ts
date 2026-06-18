import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { toErrorMessage } from '@kici-dev/shared';

/**
 * Maximum number of delivery IDs to keep in the in-memory fast-path cache.
 */
const MAX_MEMORY_CACHE_SIZE = 10_000;

/**
 * Default TTL for dedup cache entries (24 hours in milliseconds).
 */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Delivery ID deduplication cache with dual-layer storage:
 * 1. In-memory Set for hot-path performance (last 10,000 IDs)
 * 2. Database persistence via dedup_cache table for durability
 *
 * In Hybrid mode, the same webhook may arrive both via WS relay and
 * direct ingestion -- the dedup cache ensures each is processed once.
 */
export class DedupCache {
  private readonly db: Kysely<Database>;
  private readonly memoryCache = new Set<string>();
  private readonly insertionOrder: string[] = [];

  constructor(db: Kysely<Database>) {
    this.db = db;
  }

  /**
   * Check if a delivery ID has already been processed.
   * Checks in-memory cache first (fast path), then DB.
   */
  async exists(deliveryId: string): Promise<boolean> {
    // Fast path: check in-memory cache
    if (this.memoryCache.has(deliveryId)) {
      return true;
    }

    // Slow path: check database
    const rows = await this.db
      .selectFrom('dedup_cache')
      .select('delivery_id')
      .where('delivery_id', '=', deliveryId)
      .limit(1)
      .execute();

    if (rows.length > 0) {
      // Promote to in-memory cache for future fast-path hits
      this.addToMemoryCache(deliveryId);
      return true;
    }

    return false;
  }

  /**
   * Mark a delivery ID as processed.
   * Inserts into both in-memory cache and database with 24h TTL.
   * Idempotent -- duplicate marks are silently ignored.
   */
  async mark(deliveryId: string): Promise<void> {
    const expiresAt = new Date(Date.now() + DEFAULT_TTL_MS).toISOString();

    try {
      await this.db
        .insertInto('dedup_cache')
        .values({
          delivery_id: deliveryId,
          expires_at: expiresAt as unknown as Date,
        })
        .execute();
    } catch (err: unknown) {
      // Ignore unique constraint violations (idempotent mark)
      const message = toErrorMessage(err);
      if (
        !message.includes('UNIQUE') &&
        !message.includes('unique') &&
        !message.includes('duplicate key')
      ) {
        throw err;
      }
    }

    // Only promote to memory cache after DB persistence succeeds (or duplicate).
    // If we cached before the insert and the DB threw a non-unique error,
    // exists() would return true on retry even though the webhook was never processed.
    this.addToMemoryCache(deliveryId);
  }

  /**
   * Remove expired entries from the database.
   * Also trims the in-memory cache to MAX_MEMORY_CACHE_SIZE.
   *
   * @returns Number of expired entries deleted from database
   */
  async cleanup(): Promise<number> {
    const now = new Date().toISOString();

    const result = await this.db
      .deleteFrom('dedup_cache')
      .where('expires_at', '<', now as unknown as Date)
      .executeTakeFirst();

    // Trim in-memory cache if it exceeds max size
    this.trimMemoryCache();

    return Number(result.numDeletedRows);
  }

  /**
   * Add a delivery ID to the in-memory cache, maintaining insertion order.
   */
  private addToMemoryCache(deliveryId: string): void {
    if (!this.memoryCache.has(deliveryId)) {
      this.memoryCache.add(deliveryId);
      this.insertionOrder.push(deliveryId);

      // Trim if over limit
      if (this.memoryCache.size > MAX_MEMORY_CACHE_SIZE) {
        this.trimMemoryCache();
      }
    }
  }

  /**
   * Trim the in-memory cache to MAX_MEMORY_CACHE_SIZE entries,
   * removing the oldest entries first.
   */
  private trimMemoryCache(): void {
    while (this.memoryCache.size > MAX_MEMORY_CACHE_SIZE && this.insertionOrder.length > 0) {
      const oldest = this.insertionOrder.shift()!;
      this.memoryCache.delete(oldest);
    }
  }
}
