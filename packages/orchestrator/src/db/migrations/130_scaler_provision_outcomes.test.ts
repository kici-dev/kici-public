import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './130_scaler_provision_outcomes.js';

/**
 * Real-Postgres test for migration 130: asserts `public.scaler_provision_outcomes`
 * exists with its purge index after migrations 001..130, that only the two
 * identity columns are NOT NULL, that a condemnation written over an adoption
 * keeps the adoption, and that up/down are idempotent. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig130_test_${process.pid}_${Date.now()}`;

const EXPECTED_COLUMNS = [
  'agent_id',
  'scaler_name',
  'adopted_by',
  'adopted_at',
  'condemned_reason',
  'condemned_at',
  'recorded_at',
  'updated_at',
] as const;

/** The columns a provision must always carry; every verdict column is optional. */
const NOT_NULL_COLUMNS = ['agent_id', 'scaler_name', 'recorded_at', 'updated_at'] as const;

const INDEX_NAME = 'idx_scaler_provision_outcomes_updated_at';

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 130_scaler_provision_outcomes', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columns = async (): Promise<Map<string, { nullable: boolean; dataType: string }>> => {
    const r = await sql<{ column_name: string; is_nullable: string; data_type: string }>`
      SELECT column_name, is_nullable, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'scaler_provision_outcomes'
    `.execute(db);
    return new Map(
      r.rows.map((row) => [
        row.column_name,
        { nullable: row.is_nullable === 'YES', dataType: row.data_type },
      ]),
    );
  };

  const indexes = async (): Promise<string[]> => {
    const r = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'scaler_provision_outcomes'
    `.execute(db);
    return r.rows.map((row) => row.indexname);
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

  it('creates the table with every expected column', async () => {
    const cols = await columns();
    for (const name of EXPECTED_COLUMNS) {
      expect(cols.get(name), `${name} should exist`).toBeDefined();
    }
  });

  it('leaves every verdict column nullable and the identity columns NOT NULL', async () => {
    const cols = await columns();
    for (const name of NOT_NULL_COLUMNS) {
      expect(cols.get(name)!.nullable, `${name} should be NOT NULL`).toBe(false);
    }
    // A provision that was adopted has no condemnation, and one the reaper
    // condemned without an adoption has no adopter — so neither pair may be
    // required, or the store could not write either verdict on its own.
    for (const name of ['adopted_by', 'adopted_at', 'condemned_reason', 'condemned_at'] as const) {
      expect(cols.get(name)!.nullable, `${name} should be nullable`).toBe(true);
    }
  });

  it('stores both timestamp pairs as timestamptz', async () => {
    const cols = await columns();
    for (const name of ['adopted_at', 'condemned_at', 'recorded_at', 'updated_at'] as const) {
      expect(cols.get(name)!.dataType, `${name} should be timestamptz`).toBe(
        'timestamp with time zone',
      );
    }
  });

  it('keys the table on agent_id', async () => {
    const r = await sql<{ column_name: string }>`
      SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
       WHERE tc.table_schema = 'public'
         AND tc.table_name = 'scaler_provision_outcomes'
         AND tc.constraint_type = 'PRIMARY KEY'
    `.execute(db);
    expect(r.rows.map((row) => row.column_name)).toEqual(['agent_id']);
  });

  it('creates the purge index the reaper sweep scans on', async () => {
    expect(await indexes()).toContain(INDEX_NAME);
  });

  it('keeps an adoption when a condemnation is written over it', async () => {
    // The shape the store relies on: a `heartbeat-timeout` condemns a provision
    // that WAS adopted, so the two verdicts must coexist on one row.
    await sql`
      INSERT INTO public.scaler_provision_outcomes
        (agent_id, scaler_name, adopted_by, adopted_at)
      VALUES ('agent-mig130', 'github-actions', 'orch-b', now())
      ON CONFLICT (agent_id) DO NOTHING
    `.execute(db);
    await sql`
      UPDATE public.scaler_provision_outcomes
         SET condemned_reason = 'heartbeat-timeout', condemned_at = now()
       WHERE agent_id = 'agent-mig130'
    `.execute(db);
    const r = await sql<{ adopted_by: string | null; condemned_reason: string | null }>`
      SELECT adopted_by, condemned_reason
        FROM public.scaler_provision_outcomes WHERE agent_id = 'agent-mig130'
    `.execute(db);
    expect(r.rows[0]?.adopted_by).toBe('orch-b');
    expect(r.rows[0]?.condemned_reason).toBe('heartbeat-timeout');
  });

  it('is idempotent on up and down', async () => {
    await up(db);
    expect((await columns()).size).toBeGreaterThan(0);
    await down(db);
    await down(db); // idempotent: DROP TABLE IF EXISTS on an absent table
    expect((await columns()).size).toBe(0);
    await up(db);
    await up(db); // idempotent: IF NOT EXISTS on a table and index already there
    expect((await columns()).size).toBeGreaterThan(0);
    expect(await indexes()).toContain(INDEX_NAME);
  });
});
