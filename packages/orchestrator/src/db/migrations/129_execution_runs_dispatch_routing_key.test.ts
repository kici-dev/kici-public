import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './129_execution_runs_dispatch_routing_key.js';

/**
 * Real-Postgres test for migration 129: asserts
 * `execution_runs.dispatch_routing_key` exists as a nullable text column with
 * no default after migrations 001..129, and that up/down are idempotent. Gated
 * on `KICI_TEST_ADMIN_DATABASE_URL`.
 *
 * Nullability is the load-bearing part: NULL means "the same source the event
 * arrived on", which is every run except a cross-provider dispatch. A default
 * would have to name a routing key, and there is no cluster-wide one to name.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig129_test_${process.pid}_${Date.now()}`;

const COLUMN = 'dispatch_routing_key';

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 129_execution_runs_dispatch_routing_key', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columnState = async (
    table: string,
    col: string,
  ): Promise<{
    exists: boolean;
    nullable: boolean;
    dataType: string;
    columnDefault: string | null;
  }> => {
    const r = await sql<{ is_nullable: string; data_type: string; column_default: string | null }>`
      SELECT is_nullable, data_type, column_default FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ${table}
         AND column_name = ${col}
    `.execute(db);
    const row = r.rows[0];
    return {
      exists: row !== undefined,
      nullable: row?.is_nullable === 'YES',
      dataType: row?.data_type ?? '',
      columnDefault: row?.column_default ?? null,
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

  it('adds the column as nullable text with no default', async () => {
    const state = await columnState('execution_runs', COLUMN);
    expect(state.exists).toBe(true);
    expect(state.dataType).toBe('text');
    expect(state.nullable).toBe(true);
    expect(state.columnDefault).toBeNull();
  });

  it('leaves an ordinary run row NULL', async () => {
    await sql`
      INSERT INTO public.execution_runs
        (run_id, workflow_name, provider, repo_identifier, ref, sha)
      VALUES
        (gen_random_uuid(), 'mig129-ordinary', 'github', 'acme/app', 'main', 'headsha')
    `.execute(db);
    const r = await sql<{ dispatch_routing_key: string | null }>`
      SELECT dispatch_routing_key FROM public.execution_runs
       WHERE workflow_name = 'mig129-ordinary'
    `.execute(db);
    expect(r.rows[0]?.dispatch_routing_key).toBeNull();
  });

  it('stores a cross-provider dispatch key', async () => {
    await sql`
      INSERT INTO public.execution_runs
        (run_id, workflow_name, provider, repo_identifier, ref, sha,
         routing_key, dispatch_routing_key)
      VALUES
        (gen_random_uuid(), 'mig129-crossprovider', 'github', 'acme/app', 'main', 'headsha',
         'generic:inbound', 'github:99')
    `.execute(db);
    const r = await sql<{ dispatch_routing_key: string | null }>`
      SELECT dispatch_routing_key FROM public.execution_runs
       WHERE workflow_name = 'mig129-crossprovider'
    `.execute(db);
    expect(r.rows[0]?.dispatch_routing_key).toBe('github:99');
  });

  it('down() drops it and up() restores it, idempotently', async () => {
    await down(db);
    expect((await columnState('execution_runs', COLUMN)).exists).toBe(false);

    await up(db);
    await up(db); // idempotent
    expect((await columnState('execution_runs', COLUMN)).exists).toBe(true);
  });
});
