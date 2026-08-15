import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './115_global_workflows_cluster_switch.js';

/**
 * Real-Postgres test for migration 115: the global-workflows master switch
 * moves from `org_settings` to `cluster_settings`. Asserts that after
 * migrations 001..115:
 *
 * - `cluster_settings.global_workflows_enabled` exists as a nullable boolean,
 *   NULL on a fresh row (NULL ⇒ configured default);
 * - `org_settings.global_workflows_enabled` no longer exists;
 * - up() does NOT back-fill the new column from any org_settings value — a
 *   per-org opt-in must not silently become a fleet-wide one.
 *
 * Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig115_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 115_global_workflows_cluster_switch', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columnState = async (
    table: string,
    col: string,
  ): Promise<{ exists: boolean; nullable: boolean; dataType: string }> => {
    const r = await sql<{ is_nullable: string; data_type: string }>`
      SELECT is_nullable, data_type FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ${table}
         AND column_name = ${col}
    `.execute(db);
    const row = r.rows[0];
    return {
      exists: row !== undefined,
      nullable: row?.is_nullable === 'YES',
      dataType: row?.data_type ?? '',
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

  it('adds a nullable boolean cluster_settings.global_workflows_enabled that defaults to NULL', async () => {
    const state = await columnState('cluster_settings', 'global_workflows_enabled');
    expect(state.exists).toBe(true);
    expect(state.nullable).toBe(true);
    expect(state.dataType).toBe('boolean');

    await sql`
      INSERT INTO public.cluster_settings (id) VALUES ('default')
      ON CONFLICT (id) DO NOTHING
    `.execute(db);
    const r = await sql<{ global_workflows_enabled: boolean | null }>`
      SELECT global_workflows_enabled FROM public.cluster_settings WHERE id = 'default'
    `.execute(db);
    expect(r.rows[0]?.global_workflows_enabled).toBeNull();
  });

  it('drops org_settings.global_workflows_enabled', async () => {
    expect((await columnState('org_settings', 'global_workflows_enabled')).exists).toBe(false);
  });

  it('does NOT back-fill: an org row with the flag on leaves the cluster column NULL', async () => {
    // down() restores org_settings.global_workflows_enabled and drops the
    // cluster column. Seed a permissive org row BEFORE re-running up(): if up()
    // ever grows a back-fill, the cluster column would come back `true` here.
    await down(db);
    expect((await columnState('org_settings', 'global_workflows_enabled')).exists).toBe(true);
    expect((await columnState('cluster_settings', 'global_workflows_enabled')).exists).toBe(false);

    await sql`
      INSERT INTO public.org_settings (customer_id, global_workflows_enabled)
      VALUES ('org-noback', true)
      ON CONFLICT (customer_id) DO UPDATE SET global_workflows_enabled = true
    `.execute(db);

    await up(db);
    await up(db); // idempotent

    // The org column is gone again, and the cluster column is NULL — the org
    // opt-in was NOT carried forward.
    expect((await columnState('org_settings', 'global_workflows_enabled')).exists).toBe(false);
    const r = await sql<{ global_workflows_enabled: boolean | null }>`
      SELECT global_workflows_enabled FROM public.cluster_settings WHERE id = 'default'
    `.execute(db);
    expect(r.rows[0]?.global_workflows_enabled ?? null).toBeNull();
  });
});
