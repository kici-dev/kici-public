import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../migration-provider.js';
import * as m033 from './033_org_settings_approval.js';

/**
 * Real-Postgres test for migration 033.
 *
 * Creates a uniquely-named throwaway database, runs every migration up to 033
 * via the production migration provider, and asserts the two approval columns
 * exist with the right defaults. The throwaway database is dropped in teardown.
 *
 * Gated on `KICI_TEST_ADMIN_DATABASE_URL`: skips when unset, fails loudly when
 * set but unreachable.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig033_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 033_org_settings_approval', () => {
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

  const columnDefault = async (name: string): Promise<string | null> => {
    const result = await sql<{ column_default: string | null }>`
      SELECT column_default
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'org_settings'
         AND column_name = ${name}
    `.execute(db);
    return result.rows[0]?.column_default ?? null;
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

    const migrator = new Migrator({ db, provider: createMigrationProvider() });
    const { error } = await migrator.migrateToLatest();
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

  it('adds approval_expiry_seconds (default 86400) and allow_self_approval (default true)', async () => {
    expect(await colExists('approval_expiry_seconds')).toBe(true);
    expect(await colExists('allow_self_approval')).toBe(true);
    expect(await columnDefault('approval_expiry_seconds')).toContain('86400');
    expect(await columnDefault('allow_self_approval')).toContain('true');
  });

  it('up() is idempotent (re-running is a no-op)', async () => {
    await m033.up(db);
    await m033.up(db);
    expect(await colExists('approval_expiry_seconds')).toBe(true);
    expect(await colExists('allow_self_approval')).toBe(true);
  });

  it('down() drops both columns and up() restores them', async () => {
    await m033.down(db);
    expect(await colExists('approval_expiry_seconds')).toBe(false);
    expect(await colExists('allow_self_approval')).toBe(false);

    // down() is itself idempotent; up() restores the columns.
    await m033.down(db);
    await m033.up(db);
    expect(await colExists('approval_expiry_seconds')).toBe(true);
    expect(await colExists('allow_self_approval')).toBe(true);
  });
});
