import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './078_org_settings_backup_staleness.js';

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig078_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 078_org_settings_backup_staleness', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columnExists = async (): Promise<boolean> => {
    const r = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'org_settings'
           AND column_name = 'backup_staleness_warn_hours'
      ) AS exists
    `.execute(db);
    return r.rows[0]?.exists ?? false;
  };

  beforeAll(async () => {
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    await adminPool.query(`CREATE DATABASE "${TEST_DB}"`);
    await adminPool.end();
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
    // org_settings must exist before the column add — apply migrations 001..078.
    const { error } = await migrateToOwnMigration(db, import.meta.url);
    if (error) throw error;
  }, 60_000);

  afterAll(async () => {
    await db.destroy();
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    await adminPool.end();
  });

  it('adds the column, is idempotent, and down() drops it', async () => {
    expect(await columnExists()).toBe(true); // the beforeAll migration ran 078
    await up(db); // idempotent second run
    expect(await columnExists()).toBe(true);
    await down(db);
    expect(await columnExists()).toBe(false);
    await up(db);
    expect(await columnExists()).toBe(true);
  });
});
