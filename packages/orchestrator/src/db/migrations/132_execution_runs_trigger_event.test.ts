import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './132_execution_runs_trigger_event.js';
import { terminateTestDbBackends } from '../../__test-helpers__/test-db.js';

/**
 * Real-Postgres test for migration 132: asserts `execution_runs.trigger_event`
 * exists as a nullable text column with no default after migrations 001..132,
 * and that up/down are idempotent. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 *
 * Nullability is the load-bearing part: a row written before the column existed
 * has no recorded trigger, and no cluster-wide value could stand in for one. A
 * run whose trigger is unknown fails a `triggerTypeFilters` rule closed, which
 * withholds a credential rather than granting one on an unchecked rule.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig132_test_${process.pid}_${Date.now()}`;

const COLUMN = 'trigger_event';

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 132_execution_runs_trigger_event', () => {
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
      await terminateTestDbBackends(adminPool, TEST_DB);
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

  it('leaves a run recorded without a trigger event NULL', async () => {
    await sql`
      INSERT INTO public.execution_runs
        (run_id, workflow_name, provider, repo_identifier, ref, sha)
      VALUES
        (gen_random_uuid(), 'mig132-untriggered', 'github', 'acme/app', 'main', 'headsha')
    `.execute(db);
    const r = await sql<{ trigger_event: string | null }>`
      SELECT trigger_event FROM public.execution_runs
       WHERE workflow_name = 'mig132-untriggered'
    `.execute(db);
    expect(r.rows[0]?.trigger_event).toBeNull();
  });

  it('stores the recorded trigger event', async () => {
    await sql`
      INSERT INTO public.execution_runs
        (run_id, workflow_name, provider, repo_identifier, ref, sha, trigger_event)
      VALUES
        (gen_random_uuid(), 'mig132-pr', 'github', 'acme/app', 'main', 'headsha', 'pr:open')
    `.execute(db);
    const r = await sql<{ trigger_event: string | null }>`
      SELECT trigger_event FROM public.execution_runs
       WHERE workflow_name = 'mig132-pr'
    `.execute(db);
    expect(r.rows[0]?.trigger_event).toBe('pr:open');
  });

  it('down() drops it and up() restores it, idempotently', async () => {
    await down(db);
    expect((await columnState('execution_runs', COLUMN)).exists).toBe(false);

    await up(db);
    await up(db); // idempotent
    expect((await columnState('execution_runs', COLUMN)).exists).toBe(true);
  });
});
