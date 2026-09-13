import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './113_execution_runs_workflow_repo_index.js';

/**
 * Real-Postgres test for migration 113: the partial index on
 * `execution_runs.workflow_repo_identifier` exists after migrations 001..113,
 * up/down are idempotent, and — the property the index exists for — the
 * defining-repository predicate is index-eligible on BOTH arms, so the planner
 * can BitmapOr them instead of sequentially scanning the run table.
 *
 * Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig113_test_${process.pid}_${Date.now()}`;

const INDEX = 'idx_execution_runs_workflow_repo';
/** The pre-existing `repo_identifier` index (migration 001) the other arm rides. */
const REPO_INDEX = 'idx_execution_runs_repo';

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 113_execution_runs_workflow_repo_index', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const indexDef = async (name: string): Promise<string | undefined> => {
    const r = await sql<{ indexdef: string }>`
      SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'execution_runs' AND indexname = ${name}
    `.execute(db);
    return r.rows[0]?.indexdef;
  };

  /**
   * Plan the predicate `registration-run-match.ts` builds, with sequential
   * scans disabled. Disabling the seq scan asks the planner what it CAN use
   * rather than what it prefers at this row count, which is the property under
   * test — a seeded table small enough to run fast is also small enough that
   * the planner would seq-scan it whatever indexes exist.
   */
  const planDefiningRepoPredicate = async (): Promise<string> => {
    const r = await sql<{ 'QUERY PLAN': string }>`
      EXPLAIN
      SELECT run_id FROM public.execution_runs
       WHERE workflow_name = 'ci'
         AND (
           workflow_repo_identifier IN ('acme/ci-defs')
           OR (workflow_repo_identifier IS NULL AND repo_identifier IN ('acme/ci-defs'))
         )
    `.execute(db);
    return r.rows.map((row) => row['QUERY PLAN']).join('\n');
  };

  beforeAll(async () => {
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    await adminPool.query(`CREATE DATABASE "${TEST_DB}"`);
    await adminPool.end();
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
    const { error } = await migrateToOwnMigration(db, import.meta.url);
    if (error) throw error;
    // Enough rows, and skewed the way production is (the marker is set only on
    // a cross-repository global run), that ANALYZE produces real statistics.
    await sql`
      INSERT INTO public.execution_runs
        (run_id, workflow_name, provider, repo_identifier, ref, sha, workflow_repo_identifier)
      SELECT gen_random_uuid(), 'ci', 'github', 'acme/app', 'main', 'sha' || i, NULL
        FROM generate_series(1, 2000) AS i
    `.execute(db);
    await sql`
      INSERT INTO public.execution_runs
        (run_id, workflow_name, provider, repo_identifier, ref, sha, workflow_repo_identifier)
      SELECT gen_random_uuid(), 'ci', 'github', 'acme/app', 'main', 'gsha' || i, 'acme/ci-defs'
        FROM generate_series(1, 50) AS i
    `.execute(db);
    await sql`ANALYZE public.execution_runs`.execute(db);
    await sql`SET enable_seqscan = off`.execute(db);
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

  it('creates the index partial on the non-null marker', async () => {
    const def = await indexDef(INDEX);
    expect(def, `${INDEX} should exist`).toBeDefined();
    expect(def).toContain('workflow_repo_identifier');
    // Partial is what keeps it small: the marker is null for every
    // per-repository run, and `NULL IN (…)` can never match the arm anyway.
    expect(def).toMatch(/WHERE \(?workflow_repo_identifier IS NOT NULL\)?/);
  });

  it('makes both arms of the defining-repository predicate index-eligible', async () => {
    const plan = await planDefiningRepoPredicate();
    expect(plan, `plan should read ${INDEX}:\n${plan}`).toContain(INDEX);
    expect(plan, `plan should still read ${REPO_INDEX}:\n${plan}`).toContain(REPO_INDEX);
    expect(plan, `plan should not sequentially scan:\n${plan}`).not.toContain(
      'Seq Scan on execution_runs',
    );
  });

  it('down() drops the index and the predicate loses its first arm', async () => {
    await down(db);
    expect(await indexDef(INDEX)).toBeUndefined();

    // The load-bearing half of this test: with the index gone the planner has
    // nothing for `workflow_repo_identifier`, so even with seq scans disabled
    // it falls back to scanning the table — which is exactly the regression the
    // migration exists to prevent.
    const plan = await planDefiningRepoPredicate();
    expect(plan).not.toContain(INDEX);
    // One unindexable arm makes the whole disjunction unindexable, so the
    // planner scans the table even with `enable_seqscan = off`. This is the
    // pre-migration behaviour, asserted directly rather than assumed.
    expect(plan, `plan without the index should scan:\n${plan}`).toContain(
      'Seq Scan on execution_runs',
    );

    await up(db);
    await up(db); // idempotent
    expect(await indexDef(INDEX)).toBeDefined();
    expect(await planDefiningRepoPredicate()).toContain(INDEX);
  });
});
