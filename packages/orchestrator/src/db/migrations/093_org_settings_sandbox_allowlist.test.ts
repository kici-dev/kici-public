import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import * as m093 from './093_org_settings_sandbox_allowlist.js';

/**
 * Real-Postgres test for migration 093.
 *
 * Creates a uniquely-named throwaway database, applies migrations 001..093
 * via the production migration provider, and asserts the two nullable sandbox
 * allow-list columns exist (NULL = safe deny-all default). The throwaway
 * database is dropped in teardown.
 *
 * Gated on `KICI_TEST_ADMIN_DATABASE_URL`: skips when unset, fails loudly when
 * set but unreachable.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig093_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 093_org_settings_sandbox_allowlist', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;

  const colExists = async (name: string): Promise<boolean> => {
    const result = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'org_settings'
           AND column_name = ${name}
      ) AS exists
    `.execute(db);
    return result.rows[0]?.exists ?? false;
  };

  const columnNullable = async (name: string): Promise<string | null> => {
    const result = await sql<{ is_nullable: string }>`
      SELECT is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'org_settings'
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

  it('adds both nullable sandbox allow-list columns', async () => {
    expect(await colExists('sandbox_allowed_capabilities')).toBe(true);
    expect(await colExists('sandbox_allow_host_network')).toBe(true);
    expect(await columnNullable('sandbox_allowed_capabilities')).toBe('YES');
    expect(await columnNullable('sandbox_allow_host_network')).toBe('YES');
  });

  it('up() is idempotent (re-running is a no-op)', async () => {
    await m093.up(db);
    await m093.up(db);
    expect(await colExists('sandbox_allowed_capabilities')).toBe(true);
    expect(await colExists('sandbox_allow_host_network')).toBe(true);
  });

  it('down() drops both columns and up() restores them', async () => {
    await m093.down(db);
    expect(await colExists('sandbox_allowed_capabilities')).toBe(false);
    expect(await colExists('sandbox_allow_host_network')).toBe(false);

    // down() is itself idempotent; up() restores the columns.
    await m093.down(db);
    await m093.up(db);
    expect(await colExists('sandbox_allowed_capabilities')).toBe(true);
    expect(await colExists('sandbox_allow_host_network')).toBe(true);
  });
});
