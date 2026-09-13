import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { up } from './095_dashboard_write_policy_tristate.js';

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig095_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 095_dashboard_write_policy_tristate', () => {
  let db: Kysely<Record<string, never>>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const readPolicy = async (customerId: string): Promise<unknown> => {
    const r = await sql<{ dashboard_write_policy: unknown }>`
      SELECT dashboard_write_policy FROM org_settings WHERE customer_id = ${customerId}
    `.execute(db);
    return r.rows[0]?.dashboard_write_policy;
  };

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: adminUrl });
    await admin.query(`CREATE DATABASE "${TEST_DB}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely({ dialect: new PostgresDialect({ pool }) });
    // Apply migrations 001..095 (095 itself runs on an empty table, a no-op),
    // then each test seeds legacy rows and re-runs up() to exercise the backfill.
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

  it('maps false→disabled, drops true, and is idempotent', async () => {
    await sql`
      INSERT INTO org_settings (customer_id, dashboard_write_policy)
      VALUES ('cust-legacy', '{"secrets.set": false, "variables.set": true, "held_runs.approve": false}'::jsonb)
      ON CONFLICT (customer_id) DO UPDATE SET dashboard_write_policy = EXCLUDED.dashboard_write_policy
    `.execute(db);
    await up(db);
    expect(await readPolicy('cust-legacy')).toEqual({
      'secrets.set': 'disabled',
      'held_runs.approve': 'disabled',
    });
    // Idempotent: enum values are left untouched on a re-run.
    await up(db);
    expect(await readPolicy('cust-legacy')).toEqual({
      'secrets.set': 'disabled',
      'held_runs.approve': 'disabled',
    });
  });

  it('leaves an already-tri-state row untouched', async () => {
    await sql`
      INSERT INTO org_settings (customer_id, dashboard_write_policy)
      VALUES ('cust-enc', '{"secrets.set": "encrypted"}'::jsonb)
      ON CONFLICT (customer_id) DO UPDATE SET dashboard_write_policy = EXCLUDED.dashboard_write_policy
    `.execute(db);
    await up(db);
    expect(await readPolicy('cust-enc')).toEqual({ 'secrets.set': 'encrypted' });
  });

  it('leaves an all-true row as an empty object', async () => {
    await sql`
      INSERT INTO org_settings (customer_id, dashboard_write_policy)
      VALUES ('cust-perm', '{"secrets.set": true}'::jsonb)
      ON CONFLICT (customer_id) DO UPDATE SET dashboard_write_policy = EXCLUDED.dashboard_write_policy
    `.execute(db);
    await up(db);
    expect(await readPolicy('cust-perm')).toEqual({});
  });
});
