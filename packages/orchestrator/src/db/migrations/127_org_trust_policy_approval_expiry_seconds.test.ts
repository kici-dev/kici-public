import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './127_org_trust_policy_approval_expiry_seconds.js';
import { terminateTestDbBackends } from '@kici-dev/test-support/test-db';

/**
 * Real-Postgres test for migration 127: `org_trust_policy.approval_expiry_seconds` is NULLABLE,
 * an existing row stays NULL rather than backfilled, and up/down are idempotent. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 *
 * Nullability is load-bearing: a NOT NULL default would let a row from an older build claim the
 * default window instead of its operator's hours; readers resolve NULL to approval_expiry_hours.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig127_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 127_org_trust_policy_approval_expiry_seconds', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columnState = async (col: string): Promise<{ exists: boolean; nullable: boolean }> => {
    const r = await sql<{ is_nullable: string }>`
      SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'org_trust_policy'
         AND column_name = ${col}
    `.execute(db);
    const row = r.rows[0];
    return { exists: row !== undefined, nullable: row?.is_nullable === 'YES' };
  };

  beforeAll(async () => {
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
    const { error } = await migrateToOwnMigration(db, import.meta.url);
    if (error) throw error;
  }, 90_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await terminateTestDbBackends(adminPool, TEST_DB);
      await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
  }, 60_000);

  it('adds a nullable approval_expiry_seconds column', async () => {
    // Positive control: the probe can see this table, so "exists: false" is never a silent miss.
    expect((await columnState('approval_expiry_hours')).exists).toBe(true);

    const state = await columnState('approval_expiry_seconds');
    expect(state.exists).toBe(true);
    expect(state.nullable).toBe(true);
  });

  it('leaves an existing policy row NULL rather than backfilling it', async () => {
    await sql`
      INSERT INTO public.org_trust_policy
        (customer_id, fork_policy, unknown_contributor_policy, workflow_change_policy,
         approval_expiry_hours, source)
      VALUES ('org_mig127', 'hold', 'hold', 'hold', 5, 'local')
    `.execute(db);

    const r = await sql<{ approval_expiry_seconds: number | null; approval_expiry_hours: number }>`
      SELECT approval_expiry_seconds, approval_expiry_hours
        FROM public.org_trust_policy WHERE customer_id = 'org_mig127'
    `.execute(db);
    expect(r.rows[0].approval_expiry_seconds).toBeNull();
    expect(Number(r.rows[0].approval_expiry_hours)).toBe(5);
  });

  it('down() drops the column and up() restores it', async () => {
    await down(db);
    expect((await columnState('approval_expiry_seconds')).exists).toBe(false);
    await up(db);
    await up(db); // idempotent
    expect((await columnState('approval_expiry_seconds')).exists).toBe(true);
  });
});
