import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../migration-provider.js';
import { down, up } from './035_pending_workflow_contexts.js';

/**
 * Real-Postgres test for migration 035.
 *
 * Creates a throwaway database, runs every migration up to latest via the
 * production provider, and asserts the pending_workflow_contexts table + its
 * columns exist, and that `down` drops it. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig035_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 035_pending_workflow_contexts', () => {
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
       WHERE table_schema = 'public' AND table_name = 'pending_workflow_contexts'
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

  it('creates pending_workflow_contexts with run_id PK and jsonb context', async () => {
    expect(await tableExists('pending_workflow_contexts')).toBe(true);
    expect(await columns()).toEqual(['context', 'created_at', 'org_id', 'run_id']);
  });

  it('round-trips a row keyed by run_id', async () => {
    await sql`
      INSERT INTO public.pending_workflow_contexts (run_id, org_id, context)
      VALUES ('run-035', 'org-035', ${JSON.stringify({ a: 1 })}::jsonb)
    `.execute(db);
    const rows = await sql<{ run_id: string; context: { a: number } }>`
      SELECT run_id, context FROM public.pending_workflow_contexts WHERE run_id = 'run-035'
    `.execute(db);
    expect(rows.rows[0]?.context).toEqual({ a: 1 });
  });

  it('down() drops the table and up() recreates it idempotently', async () => {
    await down(db);
    expect(await tableExists('pending_workflow_contexts')).toBe(false);
    await up(db);
    await up(db); // idempotent (IF NOT EXISTS)
    expect(await tableExists('pending_workflow_contexts')).toBe(true);
  });
});
