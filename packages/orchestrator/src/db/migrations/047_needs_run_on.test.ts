import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../migration-provider.js';
import { down, up } from './047_needs_run_on.js';

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig047_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 047_needs_run_on', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columnType = async (
    table: string,
    name: string,
  ): Promise<{ data_type: string; is_nullable: string } | null> => {
    const r = await sql<{ data_type: string; is_nullable: string }>`
      SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema='public' AND table_name=${table} AND column_name=${name}`.execute(db);
    return r.rows[0] ?? null;
  };

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
    const { error } = await new Migrator({
      db,
      provider: createMigrationProvider(),
    }).migrateToLatest();
    if (error) throw error;
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,
        [TEST_DB],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('replaces if_failed with a non-null run_on text column', async () => {
    const runOn = await columnType('execution_job_needs', 'run_on');
    expect(runOn?.data_type).toBe('text');
    expect(runOn?.is_nullable).toBe('NO');
    expect(await columnType('execution_job_needs', 'if_failed')).toBeNull();
  });

  it('backfills skip→[success] and run→all-terminal, then drops if_failed', async () => {
    // Recreate the legacy shape (down adds if_failed back + drops run_on).
    await down(db);
    expect(await columnType('execution_job_needs', 'if_failed')).not.toBeNull();
    expect(await columnType('execution_job_needs', 'run_on')).toBeNull();

    // Seed two legacy needs edges (skip and run). execution_job_needs.run_id is
    // a uuid with no FK to execution_runs, so a synthetic uuid is sufficient.
    const runId = '00000000-0000-0000-0000-000000000047';
    await sql`
      INSERT INTO public.execution_job_needs (run_id, job_name, upstream_name, if_failed)
      VALUES (${runId}::uuid, 'report', 'build', 'skip'),
             (${runId}::uuid, 'report', 'probe', 'run')
    `.execute(db);

    await up(db);
    // Idempotent re-run is a no-op (if_failed already gone).
    await up(db);

    const rows = await sql<{ upstream_name: string; run_on: string }>`
      SELECT upstream_name, run_on FROM public.execution_job_needs
        WHERE run_id=${runId}::uuid ORDER BY upstream_name`.execute(db);
    const byUpstream = Object.fromEntries(rows.rows.map((r) => [r.upstream_name, r.run_on]));
    expect(JSON.parse(byUpstream['build'])).toEqual(['success']);
    expect(JSON.parse(byUpstream['probe']).sort()).toEqual(
      ['success', 'failed', 'cancelled', 'skipped', 'timed_out_stale', 'drift_dropped'].sort(),
    );
    expect(await columnType('execution_job_needs', 'if_failed')).toBeNull();
  });
});
