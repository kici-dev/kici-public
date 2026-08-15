import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './109_cluster_settings_cache_knobs.js';

/**
 * Real-Postgres test for migration 109: asserts the six cache-knob columns
 * exist on `cluster_settings` as nullable BIGINTs after migrations 001..109,
 * and that up/down are idempotent. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig109_test_${process.pid}_${Date.now()}`;

const CACHE_COLUMNS = [
  'lockfile_cache_max',
  'lockfile_cache_max_bytes',
  'lockfile_cache_ttl_ms',
  'content_cache_max',
  'content_cache_max_bytes',
  'content_cache_ttl_ms',
] as const;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 109_cluster_settings_cache_knobs', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columnState = async (
    table: string,
    col: string,
  ): Promise<{ exists: boolean; nullable: boolean; dataType: string }> => {
    const r = await sql<{ is_nullable: string; data_type: string }>`
      SELECT is_nullable, data_type FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ${table}
         AND column_name = ${col}
    `.execute(db);
    const row = r.rows[0];
    return {
      exists: row !== undefined,
      nullable: row?.is_nullable === 'YES',
      dataType: row?.data_type ?? '',
    };
  };

  beforeAll(async () => {
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    await adminPool.query(`CREATE DATABASE "${TEST_DB}"`);
    await adminPool.end();
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
      await adminPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [TEST_DB],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
  }, 60_000);

  it('adds all six nullable bigint cache columns', async () => {
    for (const column of CACHE_COLUMNS) {
      const state = await columnState('cluster_settings', column);
      expect(state.exists, `${column} should exist`).toBe(true);
      expect(state.nullable, `${column} should be nullable`).toBe(true);
      // BIGINT, not INTEGER: a 64 MiB byte ceiling and an hour-scale TTL in ms
      // both leave INTEGER range as soon as an operator raises them.
      expect(state.dataType, `${column} should be bigint`).toBe('bigint');
    }
  });

  it('round-trips a value larger than INTEGER range', async () => {
    await sql`
      INSERT INTO public.cluster_settings (id, content_cache_max_bytes)
      VALUES ('default', 8589934592)
      ON CONFLICT (id) DO UPDATE
        SET content_cache_max_bytes = EXCLUDED.content_cache_max_bytes
    `.execute(db);
    const r = await sql<{ content_cache_max_bytes: string | number | null }>`
      SELECT content_cache_max_bytes FROM public.cluster_settings WHERE id = 'default'
    `.execute(db);
    expect(Number(r.rows[0]?.content_cache_max_bytes)).toBe(8_589_934_592);
  });

  it('down() drops all six and up() restores them', async () => {
    await down(db);
    for (const column of CACHE_COLUMNS) {
      expect((await columnState('cluster_settings', column)).exists, column).toBe(false);
    }

    await up(db);
    await up(db); // idempotent
    for (const column of CACHE_COLUMNS) {
      expect((await columnState('cluster_settings', column)).exists, column).toBe(true);
    }
  });
});
