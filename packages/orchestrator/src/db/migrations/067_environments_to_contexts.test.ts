import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './067_environments_to_contexts.js';

/**
 * Real-Postgres test for migration 067. Creates a throwaway database, applies
 * migrations 001..067, and asserts the environment→context rename landed:
 * `contexts`/`context_*` tables + `context`/`contexts`/`skipped_contexts`
 * columns exist, the old `environment*` names are gone, the held-run
 * `queue_type`/`trigger_source` defaults are `'context'`, and the data UPDATE
 * migrates a pre-rename `'environment'` row to `'context'`. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig067_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

async function tableExists(db: Kysely<unknown>, name: string): Promise<boolean> {
  const result = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ${name}
  `.execute(db);
  return (result.rows[0]?.n ?? 0) > 0;
}

async function columnExists(db: Kysely<unknown>, table: string, column: string): Promise<boolean> {
  const result = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
  `.execute(db);
  return (result.rows[0]?.n ?? 0) > 0;
}

async function columnDefault(
  db: Kysely<unknown>,
  table: string,
  column: string,
): Promise<string | null> {
  const result = await sql<{ column_default: string | null }>`
    SELECT column_default FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
  `.execute(db);
  return result.rows[0]?.column_default ?? null;
}

describeDb('migration 067_environments_to_contexts', () => {
  let db: Kysely<unknown>;
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

  it('renames the context tables and drops the environment names', async () => {
    expect(await tableExists(db, 'contexts')).toBe(true);
    expect(await tableExists(db, 'context_bindings')).toBe(true);
    expect(await tableExists(db, 'context_variables')).toBe(true);
    expect(await tableExists(db, 'context_source_overrides')).toBe(true);
    expect(await tableExists(db, 'environments')).toBe(false);
    expect(await tableExists(db, 'environment_bindings')).toBe(false);
  });

  it('renames the context columns on runs, jobs, and held_runs', async () => {
    expect(await columnExists(db, 'execution_runs', 'context')).toBe(true);
    expect(await columnExists(db, 'execution_runs', 'context_id')).toBe(true);
    expect(await columnExists(db, 'execution_runs', 'environment')).toBe(false);
    expect(await columnExists(db, 'execution_jobs', 'contexts')).toBe(true);
    expect(await columnExists(db, 'execution_jobs', 'skipped_contexts')).toBe(true);
    expect(await columnExists(db, 'execution_jobs', 'environments')).toBe(false);
    expect(await columnExists(db, 'held_runs', 'context_id')).toBe(true);
    expect(await columnExists(db, 'context_bindings', 'context_id')).toBe(true);
  });

  it("defaults held_runs queue_type and trigger_source to 'context'", async () => {
    expect(await columnDefault(db, 'held_runs', 'queue_type')).toContain('context');
    expect(await columnDefault(db, 'held_runs', 'trigger_source')).toContain('context');
  });

  it("migrates a pre-rename held_runs row from 'environment' to 'context'", async () => {
    // Revert to the environment schema, seed a legacy row, then re-apply up().
    await down(db);
    // FK triggers are bypassed so we can insert without seeding parent rows.
    await sql`SET session_replication_role = replica`.execute(db);
    await sql`
      INSERT INTO public.held_runs
        (org_id, run_id, job_id, environment_id, hold_type, queue_type, trigger_source, expires_at)
      VALUES
        ('org-mig067', gen_random_uuid(), 'job-a', gen_random_uuid(), 'reviewer',
         'environment', 'environment', now() + interval '1 hour')
    `.execute(db);
    await sql`SET session_replication_role = origin`.execute(db);

    await up(db);

    const rows = await sql<{ queue_type: string; trigger_source: string }>`
      SELECT queue_type, trigger_source FROM public.held_runs WHERE org_id = 'org-mig067'
    `.execute(db);
    expect(rows.rows[0]?.queue_type).toBe('context');
    expect(rows.rows[0]?.trigger_source).toBe('context');
  });
});
