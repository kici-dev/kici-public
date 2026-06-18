/**
 * Tests for CronStore -- DB persistence for cron last-fired tracking.
 *
 * Uses a mock Kysely instance following the established pattern from
 * registration-store.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';

import { CronStore } from './cron-store.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';

// ── Tests ──────────────────────────────────────────────────────────

describe('CronStore', () => {
  describe('getAll', () => {
    it('should return all records as a Map', async () => {
      const date1 = new Date('2026-02-25T10:00:00Z');
      const date2 = new Date('2026-02-25T11:00:00Z');
      const { db } = createMockDb({
        selectRows: [
          { registration_id: 'reg-001', last_fired_at: date1 },
          { registration_id: 'reg-002', last_fired_at: date2 },
        ],
      });
      const store = new CronStore(db);

      const result = await store.getAll();

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(2);
      expect(result.get('reg-001')).toEqual(date1);
      expect(result.get('reg-002')).toEqual(date2);
    });

    it('should return empty Map when no records exist', async () => {
      const { db } = createMockDb({ selectRows: [] });
      const store = new CronStore(db);

      const result = await store.getAll();

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });
  });

  describe('tryClaimFire', () => {
    it('should return true when insert/update succeeds (claim won)', async () => {
      const { db, mocks } = createMockDb({
        insertResult: { numInsertedOrUpdatedRows: 1n },
      });
      const store = new CronStore(db);
      const firedAt = new Date('2026-02-25T10:30:00Z');

      const result = await store.tryClaimFire('reg-001', firedAt);

      expect(result).toBe(true);
      expect(mocks.insertInto).toHaveBeenCalledWith('cron_last_fired');
      expect(mocks.onConflict).toHaveBeenCalled();
    });

    it('should return false when no rows affected (claim lost)', async () => {
      const { db } = createMockDb({
        insertResult: { numInsertedOrUpdatedRows: 0n },
      });
      const store = new CronStore(db);
      const firedAt = new Date('2026-02-25T10:30:00Z');

      const result = await store.tryClaimFire('reg-001', firedAt);

      expect(result).toBe(false);
    });
  });
});
