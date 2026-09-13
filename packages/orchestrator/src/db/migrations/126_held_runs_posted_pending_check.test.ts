import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './126_held_runs_posted_pending_check.js';

/**
 * Real-Postgres test for migration 126: asserts
 * `held_runs.posted_pending_check` exists as a NULLABLE boolean with no
 * default after migrations 001..126, and that up/down are idempotent. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 *
 * The nullability is the load-bearing part. A `NOT NULL DEFAULT false` column
 * would declare every hold pending at deploy time un-posted, and the settler
 * would then decline for each — stranding the pending check those holds really
 * do carry. `null` means "nothing was recorded", which is what the shape
 * derivation is still there to answer.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig126_test_${process.pid}_${Date.now()}`;

const COLUMN = 'posted_pending_check';

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 126_held_runs_posted_pending_check', () => {
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

  it('adds the column as a nullable boolean with no default', async () => {
    const state = await columnState('held_runs', COLUMN);
    expect(state.exists).toBe(true);
    expect(state.dataType).toBe('boolean');
    expect(state.nullable).toBe(true);
    expect(state.columnDefault).toBeNull();
  });

  it('leaves a row that never set it null, not false', async () => {
    // The three-valued distinction the settler reads: null is "nothing
    // recorded, fall back to the hold's shape", false is "positively did not
    // post". A default would collapse the two.
    await sql`
      INSERT INTO public.held_runs (org_id, run_id, job_id, context_id, hold_type, reason, expires_at)
      VALUES ('org-mig126', gen_random_uuid(), 'job-mig126', NULL, 'security', 'r',
              now() + interval '1 hour')
    `.execute(db);
    const r = await sql<{ posted_pending_check: boolean | null }>`
      SELECT posted_pending_check FROM public.held_runs WHERE job_id = 'job-mig126'
    `.execute(db);
    expect(r.rows[0]?.posted_pending_check).toBeNull();
  });

  it('down() drops it and up() restores it, idempotently', async () => {
    await down(db);
    expect((await columnState('held_runs', COLUMN)).exists).toBe(false);

    await up(db);
    await up(db); // idempotent
    expect((await columnState('held_runs', COLUMN)).exists).toBe(true);
  });
});
