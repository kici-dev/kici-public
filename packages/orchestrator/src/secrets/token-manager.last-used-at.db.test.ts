/**
 * The admin token's last_used_at write against a real PostgreSQL database.
 *
 * Every authenticated admin request validates its token, and a client that
 * polls (`kici run --local` following a run reads several routes per tick)
 * validates the same token several times a second. A write per validation
 * queues on that one row's lock whenever a commit is slow, and every queued
 * write holds a pool connection until the statement timeout: enough of them
 * take the whole pool, and unrelated reads fail with a pool acquire timeout.
 */
import { afterEach, expect, it } from 'vitest';
import type pg from 'pg';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { TokenManager } from './token-manager.js';

/** Backends of this database blocked on a lock while running the last_used_at write. */
async function blockedTouches(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query LIKE 'update "admin_tokens" set "last_used_at"%'`,
  );
  return Number(rows[0]!.n);
}

async function settle(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describeWithTestDb<Database>(
  'TokenManager last_used_at writes against a real database',
  { prefix: 'kici_admin_token_touch', provider: createMigrationProvider(), poolMax: 20 },
  (getDb) => {
    let locker: pg.PoolClient | undefined;

    afterEach(async () => {
      if (locker) {
        await locker.query('ROLLBACK');
        locker.release();
        locker = undefined;
      }
    });

    // fails-when: each validation issues its own write, so N validations queue N writes
    // (and N pool connections) behind one slow commit on the token row
    it('keeps at most one last_used_at write in flight per token', async () => {
      const { db, pool } = getDb();
      const manager = new TokenManager(db);
      const { token, id } = await manager.generateToken('poller', 'admin');

      // A transaction holding the row lock stands in for a slow commit.
      locker = await pool.connect();
      await locker.query('BEGIN');
      await locker.query(`UPDATE admin_tokens SET label = label WHERE id = $1`, [id]);

      for (let i = 0; i < 8; i++) {
        expect(await manager.validate(token)).toMatchObject({ id });
      }
      await settle(300);

      expect(await blockedTouches(pool)).toBe(1);
    });

    // breaks-if-wrong: the first validation of a token still records when it was used
    it('records last_used_at on the first validation of a token', async () => {
      const { db } = getDb();
      const manager = new TokenManager(db);
      const { token, id } = await manager.generateToken('first-use', 'admin');

      await manager.validate(token);
      let lastUsed: Date | null = null;
      for (let i = 0; i < 50 && !lastUsed; i++) {
        await settle(20);
        const row = await db
          .selectFrom('admin_tokens')
          .select('last_used_at')
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        lastUsed = row.last_used_at;
      }
      expect(lastUsed).toBeInstanceOf(Date);
    });
  },
);
