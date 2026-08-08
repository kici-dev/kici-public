import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './105_org_trust_policy.js';

/**
 * Real-Postgres test for migration 104: asserts `public.org_trust_policy` exists
 * with every column NOT NULL after migrations 001..104, and that up/down are
 * idempotent. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig104_test_${process.pid}_${Date.now()}`;

const EXPECTED_COLUMNS = [
  'customer_id',
  'fork_policy',
  'unknown_contributor_policy',
  'workflow_change_policy',
  'approval_expiry_hours',
  'source',
  'updated_at',
] as const;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 105_org_trust_policy', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columns = async (): Promise<Map<string, { nullable: boolean; dataType: string }>> => {
    const r = await sql<{ column_name: string; is_nullable: string; data_type: string }>`
      SELECT column_name, is_nullable, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'org_trust_policy'
    `.execute(db);
    return new Map(
      r.rows.map((row) => [
        row.column_name,
        { nullable: row.is_nullable === 'YES', dataType: row.data_type },
      ]),
    );
  };

  beforeAll(async () => {
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    await adminPool.query(`CREATE DATABASE "${TEST_DB}"`);
    await adminPool.end();
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
    // The harness RETURNS (rather than throws) when the target migration is not
    // registered in `migration-provider.ts`, so an unchecked call leaves the
    // table absent and every assertion below fails with a confusing
    // "column should exist" instead of naming the real cause.
    const { error } = await migrateToOwnMigration(db, import.meta.url);
    if (error) throw error;
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    await adminPool.end();
  }, 60_000);

  it('creates every column as NOT NULL', async () => {
    const cols = await columns();
    for (const name of EXPECTED_COLUMNS) {
      expect(cols.get(name), `${name} should exist`).toBeDefined();
      expect(cols.get(name)!.nullable, `${name} should be NOT NULL`).toBe(false);
    }
  });

  it('stores approval_expiry_hours as an integer and updated_at as timestamptz', async () => {
    const cols = await columns();
    expect(cols.get('approval_expiry_hours')!.dataType).toBe('integer');
    expect(cols.get('updated_at')!.dataType).toBe('timestamp with time zone');
  });

  it('keys the table on customer_id', async () => {
    const r = await sql<{ column_name: string }>`
      SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
       WHERE tc.table_schema = 'public'
         AND tc.table_name = 'org_trust_policy'
         AND tc.constraint_type = 'PRIMARY KEY'
    `.execute(db);
    expect(r.rows.map((row) => row.column_name)).toEqual(['customer_id']);
  });

  it('is idempotent on up and down', async () => {
    await up(db);
    expect((await columns()).size).toBeGreaterThan(0);
    await down(db);
    expect((await columns()).size).toBe(0);
    await up(db);
    expect((await columns()).size).toBeGreaterThan(0);
  });
});
