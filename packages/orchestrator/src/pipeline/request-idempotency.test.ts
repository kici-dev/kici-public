import { beforeAll, beforeEach, expect, it } from 'vitest';
import { type Kysely, sql } from 'kysely';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { claimRequestId, pruneRequestIdempotency } from './request-idempotency.js';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';

/**
 * Real-Postgres rerun idempotency claim (atomic `INSERT … ON CONFLICT`): the
 * first hop wins (`claimed: true`), a second hop with the same `requestId`
 * loses (`claimed: false`) and reads back the SAME `new_run_id`, and exactly
 * one row exists. Also covers the 1h TTL prune. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
describeWithTestDb<Database>(
  'claimRequestId (real Postgres)',
  { prefix: 'kici_rerun_idem_test', provider: createMigrationProvider() },
  (getDb) => {
    let db: Kysely<Database>;

    beforeAll(() => {
      ({ db } = getDb());
    });

    beforeEach(async () => {
      await db.deleteFrom('request_idempotency').execute();
    });

    it('first hop claims; a re-sent requestId loses and reads back the same run id', async () => {
      const requestId = 'req-failover-1';
      const first = await claimRequestId(db, requestId);
      expect(first.claimed).toBe(true);
      expect(first.newRunId).toMatch(/^[0-9a-f-]{36}$/);

      const second = await claimRequestId(db, requestId);
      expect(second.claimed).toBe(false);
      expect(second.newRunId).toBe(first.newRunId);

      const rows = await db
        .selectFrom('request_idempotency')
        .select('new_run_id')
        .where('request_id', '=', requestId)
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.new_run_id).toBe(first.newRunId);
    });

    it('distinct requestIds each claim their own run id', async () => {
      const a = await claimRequestId(db, 'req-a');
      const b = await claimRequestId(db, 'req-b');
      expect(a.claimed).toBe(true);
      expect(b.claimed).toBe(true);
      expect(a.newRunId).not.toBe(b.newRunId);
    });

    it('prune removes rows older than 1h and keeps recent claims', async () => {
      await claimRequestId(db, 'req-recent');
      // Insert a stale row (created_at 2h ago) directly.
      await db
        .insertInto('request_idempotency')
        .values({
          request_id: 'req-stale',
          new_run_id: 'stale-run',
          created_at: sql<Date>`now() - interval '2 hours'`,
        })
        .execute();

      const deleted = await pruneRequestIdempotency(db);
      expect(deleted).toBe(1);

      const remaining = await db.selectFrom('request_idempotency').select('request_id').execute();
      expect(remaining.map((r) => r.request_id)).toEqual(['req-recent']);
    });
  },
);
