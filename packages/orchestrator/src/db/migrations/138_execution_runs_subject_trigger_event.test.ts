import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './138_execution_runs_subject_trigger_event.js';

/**
 * Real-Postgres test for migration 138: asserts `subject_trigger_event` exists
 * on `execution_runs` as a nullable text column with no default, that up/down
 * are idempotent, and that the migration backfills nothing.
 *
 * The absence of a backfill is the load-bearing part. NULL means "derive the
 * subject from `trigger_event`", which is what every row written before this
 * column existed says — so a legacy re-run keeps the subject it already mints.
 * Filling the column in would change an identity a customer's cloud trust
 * policy is already pinning, on a guess about which event that run inherited.
 *
 * Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig138_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 138_execution_runs_subject_trigger_event', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columnState = async (): Promise<{
    exists: boolean;
    nullable: boolean;
    dataType: string;
    columnDefault: string | null;
  }> => {
    const r = await sql<{ is_nullable: string; data_type: string; column_default: string | null }>`
      SELECT is_nullable, data_type, column_default FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'execution_runs'
         AND column_name = 'subject_trigger_event'
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

  it('adds subject_trigger_event as a nullable text column with no default', async () => {
    const state = await columnState();
    expect(state.exists).toBe(true);
    expect(state.dataType).toBe('text');
    expect(state.nullable).toBe(true);
    expect(state.columnDefault).toBeNull();
  });

  it('leaves a legacy re-run row NULL rather than guessing its original event', async () => {
    // The parent is inserted first: `parent_run_id` carries a self-referential
    // foreign key, so a re-run row cannot exist without the run it repeats.
    const parent = await sql<{ run_id: string }>`
      INSERT INTO public.execution_runs
        (run_id, workflow_name, provider, repo_identifier, ref, sha, trigger_event)
      VALUES
        (gen_random_uuid(), 'mig138-legacy-original', 'github', 'acme/app', 'main', 'headsha',
         'pull_request:opened')
      RETURNING run_id
    `.execute(db);
    await sql`
      INSERT INTO public.execution_runs
        (run_id, workflow_name, provider, repo_identifier, ref, sha, trigger_event, parent_run_id)
      VALUES
        (gen_random_uuid(), 'mig138-legacy-rerun', 'github', 'acme/app', 'main', 'headsha',
         'rerun', ${parent.rows[0]!.run_id}::uuid)
    `.execute(db);
    const r = await sql<{ trigger_event: string | null; subject_trigger_event: string | null }>`
      SELECT trigger_event, subject_trigger_event FROM public.execution_runs
       WHERE workflow_name = 'mig138-legacy-rerun'
    `.execute(db);
    expect(r.rows[0]?.trigger_event).toBe('rerun');
    expect(r.rows[0]?.subject_trigger_event).toBeNull();
  });

  it('stores an inherited pull-request event alongside a rerun trigger event', async () => {
    await sql`
      INSERT INTO public.execution_runs
        (run_id, workflow_name, provider, repo_identifier, ref, sha,
         trigger_event, subject_trigger_event)
      VALUES
        (gen_random_uuid(), 'mig138-rerun-of-pr', 'github', 'acme/app', 'main', 'headsha',
         'rerun', 'pull_request:opened')
    `.execute(db);
    const r = await sql<{ trigger_event: string | null; subject_trigger_event: string | null }>`
      SELECT trigger_event, subject_trigger_event FROM public.execution_runs
       WHERE workflow_name = 'mig138-rerun-of-pr'
    `.execute(db);
    // The two columns deliberately disagree: `trigger_event` is what the
    // dashboard filter and the credential relay read, `subject_trigger_event`
    // is what the OIDC subject is derived from.
    expect(r.rows[0]?.trigger_event).toBe('rerun');
    expect(r.rows[0]?.subject_trigger_event).toBe('pull_request:opened');
  });

  it('down() drops the column and up() restores it, idempotently', async () => {
    await down(db);
    expect((await columnState()).exists).toBe(false);

    await up(db);
    await up(db); // idempotent
    expect((await columnState()).exists).toBe(true);
  });
});
