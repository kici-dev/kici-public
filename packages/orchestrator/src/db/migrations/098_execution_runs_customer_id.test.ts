import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './098_execution_runs_customer_id.js';

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig098_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

/** Minimal execution_runs insert (only the NOT NULL columns + explicit overrides). */
async function insertRun(
  db: Kysely<Record<string, never>>,
  runId: string,
  overrides: { routing_key?: string | null; customer_id?: string; context?: string } = {},
): Promise<void> {
  const hasRoutingKey = 'routing_key' in overrides;
  const hasCustomerId = 'customer_id' in overrides;
  await sql`
    INSERT INTO public.execution_runs
      (run_id, workflow_name, provider, repo_identifier, ref, sha, status
       ${hasRoutingKey ? sql`, routing_key` : sql``}
       ${hasCustomerId ? sql`, customer_id` : sql``}
       ${overrides.context !== undefined ? sql`, context` : sql``})
    VALUES
      (${runId}, 'wf', 'github', 'o/r', 'refs/heads/main', 'abc', 'running'
       ${hasRoutingKey ? sql`, ${overrides.routing_key}` : sql``}
       ${hasCustomerId ? sql`, ${overrides.customer_id}` : sql``}
       ${overrides.context !== undefined ? sql`, ${overrides.context}` : sql``})
  `.execute(db);
}

async function readCustomerId(db: Kysely<Record<string, never>>, runId: string): Promise<string> {
  const row = await sql<{ customer_id: string }>`
    SELECT customer_id FROM public.execution_runs WHERE run_id = ${runId}
  `.execute(db);
  return row.rows[0]!.customer_id;
}

describeDb('migration 098_execution_runs_customer_id', () => {
  let db: Kysely<Record<string, never>>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;
  // execution_runs.run_id is a uuid column — use valid uuids, not plain labels.
  const RUN_DEFAULT = '00000000-0000-4000-b000-000000000001';
  const RUN_EXPLICIT = '00000000-0000-4000-b000-000000000002';
  const RUN_BACKFILL = '00000000-0000-4000-b000-000000000003';
  const RUN_BACKFILL_NULL = '00000000-0000-4000-b000-000000000004';

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: adminUrl });
    await admin.query(`CREATE DATABASE "${TEST_DB}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely({ dialect: new PostgresDialect({ pool }) });
    const { error } = await migrateToOwnMigration(db, import.meta.url);
    if (error) throw error;
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});
    const admin = new pg.Pool({ connectionString: adminUrl });
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`).catch(() => {});
    await admin.end();
  }, 60_000);

  it('adds customer_id defaulting to __default__ when omitted (null routing key)', async () => {
    await insertRun(db, RUN_DEFAULT, { routing_key: null });
    expect(await readCustomerId(db, RUN_DEFAULT)).toBe('__default__');
  });

  it('accepts an explicit customer_id on insert', async () => {
    await insertRun(db, RUN_EXPLICIT, { customer_id: 'org-explicit' });
    expect(await readCustomerId(db, RUN_EXPLICIT)).toBe('org-explicit');
  });

  it('backfills customer_id from generic_webhook_sources by routing_key when the column is added', async () => {
    // The backfill runs INSIDE up() only when the column is first added (it is
    // guarded by columnExists), so exercise it against the real pre-098 schema:
    // roll the column back with down(), seed a generic source (routing_key →
    // customer_id) and a legacy run created before the column existed, then run
    // up() so the ADD COLUMN + backfill block actually executes and resolves the
    // org from the source table.
    await down(db);
    await sql`
      INSERT INTO public.generic_webhook_sources
        (id, name, routing_key, customer_id, verification_method, provider_type)
      VALUES
        ('00000000-0000-4000-a000-0000000b0001', 'src', 'generic:org-b:s1', 'org-b', 'none', 'local')
      ON CONFLICT (id) DO NOTHING
    `.execute(db);
    // Legacy run inserted before the column existed, carrying the source routing_key.
    await insertRun(db, RUN_BACKFILL, {
      routing_key: 'generic:org-b:s1',
      context: 'production',
    });

    // up() adds the column (default __default__) AND backfills from the source.
    await up(db);
    expect(await readCustomerId(db, RUN_BACKFILL)).toBe('org-b');
    // A null-routing-key legacy row keeps the default (backfill skips it).
    await insertRun(db, RUN_BACKFILL_NULL, { routing_key: null, context: 'production' });
    expect(await readCustomerId(db, RUN_BACKFILL_NULL)).toBe('__default__');
  });

  it('is idempotent: re-running up() leaves a single column and index intact', async () => {
    await up(db);
    await up(db);
    const cols = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'execution_runs'
         AND column_name = 'customer_id'
    `.execute(db);
    expect(Number(cols.rows[0]!.n)).toBe(1);
    const idx = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = 'execution_runs_customer_id_context_idx'
    `.execute(db);
    expect(Number(idx.rows[0]!.n)).toBe(1);
  });
});
