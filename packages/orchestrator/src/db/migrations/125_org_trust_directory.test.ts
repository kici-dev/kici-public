import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './125_org_trust_directory.js';

/**
 * Real-Postgres test for migration 125: asserts `public.org_trust_directory`
 * exists with every column NOT NULL after migrations 001..125, that the three
 * directory columns are JSONB, and that up/down are idempotent. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig125_test_${process.pid}_${Date.now()}`;

const EXPECTED_COLUMNS = [
  'customer_id',
  'identity_links',
  'member_ci_trust',
  'team_memberships',
  'updated_at',
] as const;

const JSONB_COLUMNS = ['identity_links', 'member_ci_trust', 'team_memberships'] as const;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 125_org_trust_directory', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columns = async (): Promise<Map<string, { nullable: boolean; dataType: string }>> => {
    const r = await sql<{ column_name: string; is_nullable: string; data_type: string }>`
      SELECT column_name, is_nullable, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'org_trust_directory'
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

  it('creates every column as NOT NULL', async () => {
    const cols = await columns();
    for (const name of EXPECTED_COLUMNS) {
      expect(cols.get(name), `${name} should exist`).toBeDefined();
      expect(cols.get(name)!.nullable, `${name} should be NOT NULL`).toBe(false);
    }
  });

  it('stores the three directory columns as jsonb and updated_at as timestamptz', async () => {
    const cols = await columns();
    for (const name of JSONB_COLUMNS) {
      expect(cols.get(name)!.dataType, `${name} should be jsonb`).toBe('jsonb');
    }
    expect(cols.get('updated_at')!.dataType).toBe('timestamp with time zone');
  });

  it('keys the table on customer_id', async () => {
    const r = await sql<{ column_name: string }>`
      SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
       WHERE tc.table_schema = 'public'
         AND tc.table_name = 'org_trust_directory'
         AND tc.constraint_type = 'PRIMARY KEY'
    `.execute(db);
    expect(r.rows.map((row) => row.column_name)).toEqual(['customer_id']);
  });

  it('reads a jsonb document back as parsed JSON', async () => {
    await sql`
      INSERT INTO public.org_trust_directory
        (customer_id, identity_links, member_ci_trust, team_memberships)
      VALUES (
        'org-mig125',
        ${JSON.stringify([{ userId: 'u1', provider: 'github', providerUsername: 'octo' }])}::jsonb,
        ${JSON.stringify({ u1: 'write' })}::jsonb,
        ${JSON.stringify([{ teamName: 'sre', memberUserIds: ['u1'] }])}::jsonb
      )
      ON CONFLICT (customer_id) DO NOTHING
    `.execute(db);
    const r = await sql<{
      identity_links: unknown;
      member_ci_trust: unknown;
      team_memberships: unknown;
    }>`
      SELECT identity_links, member_ci_trust, team_memberships
        FROM public.org_trust_directory WHERE customer_id = 'org-mig125'
    `.execute(db);
    expect(r.rows[0]?.identity_links).toEqual([
      { userId: 'u1', provider: 'github', providerUsername: 'octo' },
    ]);
    expect(r.rows[0]?.member_ci_trust).toEqual({ u1: 'write' });
    expect(r.rows[0]?.team_memberships).toEqual([{ teamName: 'sre', memberUserIds: ['u1'] }]);
  });

  it('is idempotent on up and down', async () => {
    await up(db);
    expect((await columns()).size).toBeGreaterThan(0);
    await down(db);
    await down(db); // idempotent: DROP TABLE IF EXISTS on an absent table
    expect((await columns()).size).toBe(0);
    await up(db);
    await up(db); // idempotent: CREATE TABLE IF NOT EXISTS on a present table
    expect((await columns()).size).toBeGreaterThan(0);
  });
});
