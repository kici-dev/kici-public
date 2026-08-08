import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import * as m080 from './080_cluster_settings.js';

/**
 * Real-Postgres test for migration 080.
 *
 * Creates a uniquely-named throwaway database, applies migrations 001..080
 * via the production migration provider, and asserts the singleton
 * `cluster_settings` table exists with all 8 nullable knob columns and a
 * CHECK-constrained fixed primary key.
 *
 * Gated on `KICI_TEST_ADMIN_DATABASE_URL`: skips when unset, fails loudly when
 * set but unreachable.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig080_test_${process.pid}_${Date.now()}`;

const KNOB_COLUMNS = [
  'max_github_payload_bytes',
  'event_log_max_payload_bytes',
  'lock_file_max_bytes',
  'webhook_dedup_ttl_ms',
  'contributor_cache_ttl_ms',
  'event_router_event_ttl_seconds',
  'event_router_max_dispatch_attempts',
  'queue_max_depth',
];

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 080_cluster_settings', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;

  const tableExists = async (name: string): Promise<boolean> => {
    const result = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ${name}
      ) AS exists
    `.execute(db);
    return result.rows[0]?.exists ?? false;
  };

  const columnNullable = async (name: string): Promise<string | null> => {
    const result = await sql<{ is_nullable: string }>`
      SELECT is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'cluster_settings'
         AND column_name = ${name}
    `.execute(db);
    return result.rows[0]?.is_nullable ?? null;
  };

  const adminUrl = ADMIN_URL!;

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
      await adminPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [TEST_DB],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
  }, 60_000);

  it('creates cluster_settings with 8 nullable knob columns', async () => {
    expect(await tableExists('cluster_settings')).toBe(true);
    for (const col of KNOB_COLUMNS) {
      expect(await columnNullable(col)).toBe('YES');
    }
  });

  it('enforces the singleton row (a second id is rejected)', async () => {
    await sql`INSERT INTO cluster_settings (id) VALUES ('default') ON CONFLICT (id) DO NOTHING`.execute(
      db,
    );
    await expect(
      sql`INSERT INTO cluster_settings (id) VALUES ('other')`.execute(db),
    ).rejects.toThrow();
  });

  it('up() is idempotent (re-running is a no-op)', async () => {
    await m080.up(db);
    await m080.up(db);
    expect(await tableExists('cluster_settings')).toBe(true);
  });

  it('down() drops the table and up() restores it', async () => {
    await m080.down(db);
    expect(await tableExists('cluster_settings')).toBe(false);

    await m080.down(db);
    await m080.up(db);
    expect(await tableExists('cluster_settings')).toBe(true);
  });
});
