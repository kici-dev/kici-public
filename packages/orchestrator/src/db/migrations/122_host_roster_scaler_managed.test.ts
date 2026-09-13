import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './122_host_roster_scaler_managed.js';

/**
 * Real-Postgres test for migration 122: asserts `host_roster.scaler_managed`
 * exists as a NOT NULL boolean defaulting to false after migrations 001..122,
 * that a row written BEFORE the column existed reads false, and that up/down
 * are idempotent. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig122_test_${process.pid}_${Date.now()}`;

const COLUMN = 'scaler_managed';

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 122_host_roster_scaler_managed', () => {
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

  const seedHost = async (agentId: string): Promise<void> => {
    await sql`
      INSERT INTO public.host_roster (agent_id, lifecycle_class, labels)
      VALUES (${agentId}, 'static', '["role:web"]')
      ON CONFLICT (agent_id) DO NOTHING
    `.execute(db);
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

  it('adds the column as a NOT NULL boolean', async () => {
    const state = await columnState('host_roster', COLUMN);
    expect(state.exists).toBe(true);
    expect(state.dataType).toBe('boolean');
    expect(state.nullable).toBe(false);
  });

  it('backfills a row that predates the column as NOT scaler-managed', async () => {
    // The load-bearing assertion. An existing fleet host must stay a `runsOnAll`
    // fan-out target the moment the migration lands — waiting for it to
    // re-register would silently shrink every fan-out in between. So the column
    // must default false, never true and never nullable-meaning-true.
    await down(db);
    expect((await columnState('host_roster', COLUMN)).exists).toBe(false);
    await seedHost('pre-migration-host');
    await up(db);

    const r = await sql<{ scaler_managed: boolean }>`
      SELECT scaler_managed FROM public.host_roster WHERE agent_id = 'pre-migration-host'
    `.execute(db);
    expect(r.rows[0]?.scaler_managed).toBe(false);
  });

  it('defaults a freshly inserted row to false', async () => {
    await seedHost('post-migration-host');
    const r = await sql<{ scaler_managed: boolean }>`
      SELECT scaler_managed FROM public.host_roster WHERE agent_id = 'post-migration-host'
    `.execute(db);
    expect(r.rows[0]?.scaler_managed).toBe(false);
  });

  it('down() drops it and up() restores it, idempotently', async () => {
    await down(db);
    expect((await columnState('host_roster', COLUMN)).exists).toBe(false);

    await up(db);
    await up(db); // idempotent
    expect((await columnState('host_roster', COLUMN)).exists).toBe(true);
  });
});
