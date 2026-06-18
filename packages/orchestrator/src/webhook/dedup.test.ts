import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { DedupCache } from './dedup.js';

// ── Mock DB builder helpers ──────────────────────────────────────

/**
 * Create a mock Kysely instance that simulates the query chain.
 * Uses an in-memory Map to simulate DB state for stateful dedup tests.
 *
 * NOTE: This test uses a specialized stateful mock (in-memory Map) instead of
 * the shared createMockDb() from '../__test-helpers__/mock-db.js' because
 * DedupCache tests require actual state tracking between operations.
 */
function createMockDb() {
  const store = new Map<string, { delivery_id: string; expires_at: string }>();

  const mockDb = {
    selectFrom: vi.fn().mockImplementation(() => ({
      select: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation((_col: string, _op: string, deliveryId: string) => ({
          limit: vi.fn().mockImplementation(() => ({
            execute: vi.fn().mockImplementation(async () => {
              const entry = store.get(deliveryId);
              return entry ? [entry] : [];
            }),
          })),
        })),
      })),
    })),
    insertInto: vi.fn().mockImplementation(() => ({
      values: vi
        .fn()
        .mockImplementation((values: { delivery_id: string; expires_at: unknown }) => ({
          execute: vi.fn().mockImplementation(async () => {
            if (store.has(values.delivery_id)) {
              throw new Error('UNIQUE constraint failed: dedup_cache.delivery_id');
            }
            store.set(values.delivery_id, {
              delivery_id: values.delivery_id,
              expires_at: String(values.expires_at),
            });
          }),
        })),
    })),
    deleteFrom: vi.fn().mockImplementation(() => ({
      where: vi.fn().mockImplementation((_col: string, _op: string, threshold: string) => ({
        executeTakeFirst: vi.fn().mockImplementation(async () => {
          let deleted = 0;
          for (const [key, entry] of store.entries()) {
            if (entry.expires_at < threshold) {
              store.delete(key);
              deleted++;
            }
          }
          return { numDeletedRows: BigInt(deleted) };
        }),
      })),
    })),
    _store: store,
  } as unknown as Kysely<Database> & { _store: typeof store };

  return mockDb;
}

// ── Tests ────────────────────────────────────────────────────────

describe('DedupCache', () => {
  let db: ReturnType<typeof createMockDb>;
  let dedup: DedupCache;

  beforeEach(() => {
    db = createMockDb();
    dedup = new DedupCache(db);
  });

  describe('exists()', () => {
    it('returns false for unseen delivery ID', async () => {
      const result = await dedup.exists('delivery-001');
      expect(result).toBe(false);
    });

    it('returns true after mark()', async () => {
      await dedup.mark('delivery-001');
      const result = await dedup.exists('delivery-001');
      expect(result).toBe(true);
    });

    it('returns false for different delivery ID', async () => {
      await dedup.mark('delivery-001');
      const result = await dedup.exists('delivery-002');
      expect(result).toBe(false);
    });
  });

  describe('mark()', () => {
    it('is idempotent -- double mark does not throw', async () => {
      await dedup.mark('delivery-001');
      await expect(dedup.mark('delivery-001')).resolves.not.toThrow();
    });

    it('does not cache in memory when DB insert fails with non-unique error', async () => {
      // Override insertInto to simulate a transient DB error
      db.insertInto = vi.fn().mockImplementation(() => ({
        values: vi.fn().mockImplementation(() => ({
          execute: vi.fn().mockRejectedValue(new Error('connection refused')),
        })),
      }));

      await expect(dedup.mark('delivery-err')).rejects.toThrow('connection refused');

      // The entry should NOT be in memory -- a retry must be able to process it
      const result = await dedup.exists('delivery-err');
      expect(result).toBe(false);
    });

    it('stores entry in DB with expires_at ~24h from now', async () => {
      await dedup.mark('delivery-001');

      const entry = db._store.get('delivery-001');
      expect(entry).toBeDefined();
      expect(entry!.delivery_id).toBe('delivery-001');

      // expires_at should be ~24 hours from now
      const expiresAt = new Date(entry!.expires_at);
      const expectedMin = Date.now() + 23 * 60 * 60 * 1000;
      const expectedMax = Date.now() + 25 * 60 * 60 * 1000;
      expect(expiresAt.getTime()).toBeGreaterThan(expectedMin);
      expect(expiresAt.getTime()).toBeLessThan(expectedMax);
    });
  });

  describe('cleanup()', () => {
    it('removes expired entries and returns count', async () => {
      // Insert an already-expired entry directly into mock store
      const pastDate = new Date(Date.now() - 1000).toISOString();
      db._store.set('expired-001', {
        delivery_id: 'expired-001',
        expires_at: pastDate,
      });

      // Insert a valid entry
      await dedup.mark('valid-001');

      const deleted = await dedup.cleanup();

      expect(deleted).toBe(1);
      expect(db._store.has('expired-001')).toBe(false);
      expect(db._store.has('valid-001')).toBe(true);
    });

    it('returns 0 when no expired entries', async () => {
      await dedup.mark('valid-001');
      const deleted = await dedup.cleanup();
      expect(deleted).toBe(0);
    });
  });

  describe('in-memory cache fast path', () => {
    it('serves from memory after mark() without DB query', async () => {
      await dedup.mark('delivery-001');

      // Reset mocks to track new calls
      vi.mocked(db.selectFrom).mockClear();

      const result = await dedup.exists('delivery-001');
      expect(result).toBe(true);
      // Should not have queried DB -- served from memory
      expect(db.selectFrom).not.toHaveBeenCalled();
    });

    it('promotes DB-found entries to memory cache', async () => {
      // Insert directly into mock store (bypassing memory cache)
      const expiresAt = new Date(Date.now() + 86400000).toISOString();
      db._store.set('db-only-001', {
        delivery_id: 'db-only-001',
        expires_at: expiresAt,
      });

      // First exists() finds in DB
      const firstCheck = await dedup.exists('db-only-001');
      expect(firstCheck).toBe(true);

      // Reset selectFrom to verify second call doesn't hit DB
      vi.mocked(db.selectFrom).mockClear();

      // Second exists() should find in memory (promoted)
      const secondCheck = await dedup.exists('db-only-001');
      expect(secondCheck).toBe(true);
      expect(db.selectFrom).not.toHaveBeenCalled();
    });
  });
});
