import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './083_org_settings_artifact_caps.js';

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig083_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 083_org_settings_artifact_caps', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columnState = async (col: string): Promise<{ exists: boolean; nullable: boolean }> => {
    const r = await sql<{ is_nullable: string }>`
      SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'org_settings'
         AND column_name = ${col}
    `.execute(db);
    const row = r.rows[0];
    return { exists: row !== undefined, nullable: row?.is_nullable === 'YES' };
  };

  beforeAll(async () => {
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    await adminPool.query(`CREATE DATABASE "${TEST_DB}"`);
    await adminPool.end();
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
    // org_settings must exist before the column add — apply migrations 001..083.
    const { error } = await migrateToOwnMigration(db, import.meta.url);
    if (error) throw error;
  }, 60_000);

  afterAll(async () => {
    await db.destroy();
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    await adminPool.end();
  });

  it('adds both nullable columns, is idempotent, and down() drops them', async () => {
    // the beforeAll migration ran 083 already — both columns exist and are nullable.
    for (const col of ['artifact_max_bytes', 'artifact_max_per_run']) {
      const state = await columnState(col);
      expect(state.exists).toBe(true);
      expect(state.nullable).toBe(true);
    }
    await up(db); // idempotent second run
    expect((await columnState('artifact_max_bytes')).exists).toBe(true);
    await down(db);
    expect((await columnState('artifact_max_bytes')).exists).toBe(false);
    expect((await columnState('artifact_max_per_run')).exists).toBe(false);
    await up(db);
    expect((await columnState('artifact_max_bytes')).nullable).toBe(true);
    expect((await columnState('artifact_max_per_run')).nullable).toBe(true);
  });
});
