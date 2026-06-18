import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../migration-provider.js';
import { down, up } from './038_remote_sources.js';

/**
 * Real-Postgres test for migration 038.
 *
 * Creates a throwaway database, runs every migration up to latest via the
 * production provider, and asserts the remote_sources table + its columns
 * exist with the expected unique constraints. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig038_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 038_remote_sources', () => {
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

  const columns = async (): Promise<string[]> => {
    const result = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'remote_sources'
    `.execute(db);
    return result.rows.map((r) => r.column_name).sort();
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

  it('creates remote_sources with the expected columns', async () => {
    expect(await tableExists('remote_sources')).toBe(true);
    expect(await columns()).toEqual([
      'cluster_id',
      'created_at',
      'customer_id',
      'routing_key',
      'updated_at',
    ]);
  });

  it('enforces unique customer_id and routing_key', async () => {
    await sql`
      INSERT INTO public.remote_sources (customer_id, routing_key, cluster_id)
      VALUES ('org_abc', 'remote:org_abc', 'c1')
    `.execute(db);

    await expect(
      sql`
        INSERT INTO public.remote_sources (customer_id, routing_key, cluster_id)
        VALUES ('org_abc', 'remote:org_other', 'c2')
      `.execute(db),
    ).rejects.toThrow();

    await expect(
      sql`
        INSERT INTO public.remote_sources (customer_id, routing_key, cluster_id)
        VALUES ('org_other', 'remote:org_abc', 'c2')
      `.execute(db),
    ).rejects.toThrow();
  });

  it('down() drops the table and up() recreates it idempotently', async () => {
    await down(db);
    expect(await tableExists('remote_sources')).toBe(false);
    await up(db);
    await up(db); // idempotent (existence guard)
    expect(await tableExists('remote_sources')).toBe(true);
  });
});
