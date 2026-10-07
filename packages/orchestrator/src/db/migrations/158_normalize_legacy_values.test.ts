import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { ExecutionRunStatus, HoldType } from '@kici-dev/engine';
import { migrateToOwnMigration, migrateToPreviousMigration } from '../migration-test-harness.js';
import { down, up } from './158_normalize_legacy_values.js';
import { terminateTestDbBackends } from '../../__test-helpers__/test-db.js';

/**
 * Real-Postgres test for migration 158. Seeds every legacy spelling BEFORE the
 * migration, the way an upgraded database carries them, then asserts the
 * rewrite. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig158_test_${process.pid}_${Date.now()}`;

const LEGACY_STATUSES = ['passed', 'completed', 'in_progress', 'error', 'canceled', 'waiting'];

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

async function seedLegacyRows(db: Kysely<unknown>): Promise<void> {
  for (const holdType of ['approval', 'wait_timer', HoldType.enum.concurrency]) {
    await sql`
      INSERT INTO public.held_runs (org_id, run_id, job_id, context_id, hold_type, expires_at)
      VALUES ('org-mig158', gen_random_uuid(), 'job-1', NULL, ${holdType}, now() + interval '1 hour')
    `.execute(db);
  }
  for (const status of [...LEGACY_STATUSES, ExecutionRunStatus.enum.success]) {
    const runId = crypto.randomUUID();
    await sql`
      INSERT INTO public.execution_runs (run_id, workflow_name, provider, repo_identifier, ref, sha, status)
      VALUES (${runId}, 'wf', 'github', 'o/r', 'refs/heads/main', 'abc', ${status})
    `.execute(db);
    await sql`
      INSERT INTO public.execution_jobs (run_id, job_id, job_name, status)
      VALUES (${runId}, 'job-1', 'build', ${status})
    `.execute(db);
    await sql`
      INSERT INTO public.execution_steps (run_id, job_id, step_index, step_name, status)
      VALUES (${runId}, 'job-1', 0, 'step', ${status})
    `.execute(db);
  }
  await sql`
    INSERT INTO public.org_trust_policy (customer_id, fork_policy, approval_expiry_hours, approval_expiry_seconds, source)
    VALUES ('org-hours-only', 'hold', 72, NULL, 'platform'),
           ('org-seconds', 'hold', 1, 900, 'platform')
  `.execute(db);
}

describeDb('migration 158_normalize_legacy_values', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const col = async (query: string): Promise<string[]> =>
    (await sql<{ v: string }>`${sql.raw(query)}`.execute(db)).rows.map((r) => r.v).sort();

  beforeAll(async () => {
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
    const before = await migrateToPreviousMigration(db, import.meta.url);
    if (before.error) throw before.error;
    await seedLegacyRows(db);
    const after = await migrateToOwnMigration(db, import.meta.url);
    if (after.error) throw after.error;
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

  it('rewrites the legacy hold types', async () => {
    // fails-when: the hold-type rewrite is missing (`approval` / `wait_timer` survive).
    expect(await col('SELECT hold_type AS v FROM public.held_runs')).toEqual(
      [HoldType.enum.concurrency, HoldType.enum.reviewer, HoldType.enum.timer].sort(),
    );
  });

  it.each(['execution_runs', 'execution_jobs', 'execution_steps'])(
    'rewrites every legacy status in %s',
    async (table) => {
      // fails-when: a table or an alias is missing from the rewrite.
      const statuses = await col(`SELECT status AS v FROM public.${table}`);
      expect(statuses).toEqual(
        [
          ExecutionRunStatus.enum.cancelled,
          ExecutionRunStatus.enum.failed,
          ExecutionRunStatus.enum.pending,
          ExecutionRunStatus.enum.running,
          // `passed`, `completed` and the canonical seed: an already-canonical
          // row survives untouched (breaks-if-wrong).
          ExecutionRunStatus.enum.success,
          ExecutionRunStatus.enum.success,
          ExecutionRunStatus.enum.success,
        ].sort(),
      );
    },
  );

  it('backfills approval_expiry_seconds from hours, keeps an explicit value, and drops hours', async () => {
    // fails-when: the backfill guesses a default instead of hours * 3600, or
    // overwrites a row that already carried seconds.
    const rows = await sql<{ customer_id: string; approval_expiry_seconds: number }>`
      SELECT customer_id, approval_expiry_seconds FROM public.org_trust_policy ORDER BY customer_id
    `.execute(db);
    expect(rows.rows).toEqual([
      { customer_id: 'org-hours-only', approval_expiry_seconds: 72 * 3600 },
      { customer_id: 'org-seconds', approval_expiry_seconds: 900 },
    ]);
    const columns = await sql<{ column_name: string; is_nullable: string }>`
      SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'org_trust_policy'
         AND column_name IN ('approval_expiry_hours', 'approval_expiry_seconds')
    `.execute(db);
    expect(columns.rows).toEqual([{ column_name: 'approval_expiry_seconds', is_nullable: 'NO' }]);
  });

  it('is idempotent: a re-run on the migrated schema succeeds and changes nothing', async () => {
    // fails-when: the hours backfill runs unguarded and references the dropped column.
    await expect(up(db)).resolves.toBeUndefined();
    expect(await col('SELECT hold_type AS v FROM public.held_runs')).toEqual(
      [HoldType.enum.concurrency, HoldType.enum.reviewer, HoldType.enum.timer].sort(),
    );
  });

  it('down is a no-op: the rewritten values stay', async () => {
    // breaks-if-wrong: a down that restored the aliases would hand them back to
    // readers that no longer accept them.
    await expect(down()).resolves.toBeUndefined();
    expect(await col('SELECT hold_type AS v FROM public.held_runs')).toEqual(
      [HoldType.enum.concurrency, HoldType.enum.reviewer, HoldType.enum.timer].sort(),
    );
  });
});
