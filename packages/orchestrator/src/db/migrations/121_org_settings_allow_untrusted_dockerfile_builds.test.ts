import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './121_org_settings_allow_untrusted_dockerfile_builds.js';

/**
 * Real-Postgres test for migration 121: asserts
 * `org_settings.allow_untrusted_dockerfile_builds` exists as a NOT NULL boolean
 * defaulting to false after migrations 001..121, and that up/down are
 * idempotent. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig121_test_${process.pid}_${Date.now()}`;

const COLUMN = 'allow_untrusted_dockerfile_builds';

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 121_org_settings_allow_untrusted_dockerfile_builds', () => {
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

  it('adds the column as a NOT NULL boolean defaulting to false', async () => {
    const state = await columnState('org_settings', COLUMN);
    expect(state.exists).toBe(true);
    expect(state.dataType).toBe('boolean');
    // NOT NULL with a default, unlike the nullable cluster knobs: this is a
    // policy flag with a meaningful "off", not a "never set" sentinel.
    expect(state.nullable).toBe(false);
  });

  it('defaults an existing org row to deny', async () => {
    // Default-deny is the whole point — a Dockerfile build is not sandboxed, so
    // an org must opt in rather than inherit the capability.
    await sql`
      INSERT INTO public.org_settings (customer_id) VALUES ('org-mig121')
      ON CONFLICT DO NOTHING
    `.execute(db);
    const r = await sql<{ allow_untrusted_dockerfile_builds: boolean }>`
      SELECT allow_untrusted_dockerfile_builds FROM public.org_settings
       WHERE customer_id = 'org-mig121'
    `.execute(db);
    expect(r.rows[0]?.allow_untrusted_dockerfile_builds).toBe(false);
  });

  it('down() drops it and up() restores it, idempotently', async () => {
    await down(db);
    expect((await columnState('org_settings', COLUMN)).exists).toBe(false);

    await up(db);
    await up(db); // idempotent
    expect((await columnState('org_settings', COLUMN)).exists).toBe(true);
  });
});
