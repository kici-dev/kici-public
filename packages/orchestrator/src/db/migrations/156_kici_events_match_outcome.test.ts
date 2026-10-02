import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import * as m156 from './156_kici_events_match_outcome.js';
import { terminateTestDbBackends } from '../../__test-helpers__/test-db.js';

/**
 * Real-Postgres test for migration 156. Applies migrations up to 156 in a
 * throwaway database and asserts the two nullable, default-less match-outcome
 * columns on `kici_events`. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig156_test_${process.pid}_${Date.now()}`;
const COLUMNS = {
  match_outcome: 'text',
  matched_count: 'integer',
} as const;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 156_kici_events_match_outcome', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columnMeta = async (
    column: string,
  ): Promise<{ type: string; nullable: string; defaultValue: string | null } | null> => {
    const result = await sql<{
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>`
      SELECT data_type, is_nullable, column_default
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'kici_events'
         AND column_name = ${column}
    `.execute(db);
    const row = result.rows[0];
    return row
      ? { type: row.data_type, nullable: row.is_nullable, defaultValue: row.column_default }
      : null;
  };

  beforeAll(async () => {
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
    const { error } = await migrateToOwnMigration(db, import.meta.url);
    if (error) throw error;
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await terminateTestDbBackends(adminPool, TEST_DB);
      await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
  }, 60_000);

  it('adds both columns nullable, typed, with no default', async () => {
    // fails-when: a column is missing, NOT NULL, mistyped, or carries a DEFAULT
    // (a default would claim an outcome for rows processed before the column).
    for (const [column, type] of Object.entries(COLUMNS)) {
      expect(await columnMeta(column)).toEqual({ type, nullable: 'YES', defaultValue: null });
    }
  });

  it('stores an outcome on a processed row and reads null on one without', async () => {
    const insert = async (name: string): Promise<string> => {
      const res = await sql<{ id: string }>`
        INSERT INTO kici_events (event_name, payload, chain_depth, expires_at)
        VALUES (${name}, '{}'::jsonb, 0, now() + interval '1 day')
        RETURNING id
      `.execute(db);
      return res.rows[0]!.id;
    };
    const withOutcome = await insert('kici.scaler.scale-up');
    const without = await insert('__workflow_complete');
    await sql`UPDATE kici_events SET processed = true, match_outcome = 'no-target-repo',
                matched_count = 0 WHERE id = ${withOutcome}`.execute(db);
    const rows = await sql<{
      id: string;
      match_outcome: string | null;
      matched_count: number | null;
    }>`
      SELECT id, match_outcome, matched_count FROM kici_events WHERE id IN (${withOutcome}, ${without})
    `.execute(db);
    const byId = new Map(rows.rows.map((r) => [r.id, r]));
    expect(byId.get(withOutcome)).toMatchObject({
      match_outcome: 'no-target-repo',
      matched_count: 0,
    });
    expect(byId.get(without)).toMatchObject({ match_outcome: null, matched_count: null });
  });

  it('up() is idempotent', async () => {
    await m156.up(db);
    await m156.up(db);
    for (const column of Object.keys(COLUMNS)) {
      expect(await columnMeta(column)).not.toBeNull();
    }
  });

  it('down() drops both columns and up() restores them', async () => {
    await m156.down(db);
    for (const column of Object.keys(COLUMNS)) {
      expect(await columnMeta(column)).toBeNull();
    }
    await m156.down(db);
    await m156.up(db);
    for (const column of Object.keys(COLUMNS)) {
      expect(await columnMeta(column)).not.toBeNull();
    }
  });
});
