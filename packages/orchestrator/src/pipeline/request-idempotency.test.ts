import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { claimRequestId, pruneRequestIdempotency } from './request-idempotency.js';

/**
 * Real-Postgres test for the rerun idempotency claim. Creates a throwaway
 * database, migrates to latest, and drives the atomic `INSERT … ON CONFLICT`
 * claim: the first hop wins (`claimed: true`), a second hop with the same
 * `requestId` loses (`claimed: false`) and reads back the SAME `new_run_id`,
 * and exactly one row exists. Also exercises the 1h TTL prune. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_rerun_idem_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('claimRequestId (real Postgres)', () => {
  let db: Kysely<Database>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  beforeAll(async () => {
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    const { error } = await new Migrator({
      db: db as unknown as Kysely<unknown>,
      provider: createMigrationProvider(),
    }).migrateToLatest();
    if (error) throw error;
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [TEST_DB],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
  }, 60_000);

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
});
