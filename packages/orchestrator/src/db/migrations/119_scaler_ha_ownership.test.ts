import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './119_scaler_ha_ownership.js';

/**
 * Real-Postgres test for migration 119: asserts the scaler HA ownership schema
 * exists after migrations 001..119 — the `scaler_pending_claims` table with its
 * single-use `consumed_at`, the self-describing ownership columns on
 * `scaler_spawning_agents`, and `owner_instance_id` on `scaler_reservations` —
 * and that up/down are idempotent. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig119_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

/**
 * Every ownership column migration 119 adds to `scaler_spawning_agents`, paired
 * with the `information_schema.columns.data_type` it must report. The type is
 * pinned, not just the name: a `mandatory_labels` added as TEXT instead of JSONB
 * would satisfy an existence-only assertion and fail at the first array read.
 */
const SPAWNING_COLUMNS: Array<[string, string]> = [
  ['owner_instance_id', 'text'],
  ['adopted_by', 'text'],
  ['adopted_at', 'timestamp with time zone'],
  ['mandatory_labels', 'jsonb'],
  ['provisioning_targets', 'jsonb'],
  ['roles', 'jsonb'],
  ['backend_type', 'text'],
];

/**
 * Every column of `scaler_pending_claims`, with its data type. All ten are
 * listed so a column omitted from the CREATE TABLE fails here rather than at the
 * first INSERT a later change writes.
 *
 * `agent_token_ttl_ms` is pinned to `bigint` deliberately: the TypeScript select
 * type in `db/types.ts` is `string` precisely because node-pg returns int8 as a
 * string, and that only holds while the column really is a BIGINT.
 */
const CLAIMS_COLUMNS: Array<[string, string]> = [
  ['claim_hash', 'text'],
  ['claim_prefix', 'text'],
  ['agent_id', 'text'],
  ['scaler_name', 'text'],
  ['labels', 'jsonb'],
  ['agent_token_ttl_ms', 'bigint'],
  ['orchestrator_url', 'text'],
  ['expires_at', 'timestamp with time zone'],
  ['consumed_at', 'timestamp with time zone'],
  ['created_at', 'timestamp with time zone'],
];

describeDb('migration 119_scaler_ha_ownership', () => {
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

  const indexExists = async (name: string): Promise<boolean> => {
    const r = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public' AND indexname = ${name}
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

  it('creates scaler_pending_claims with every column at its declared type', async () => {
    for (const [col, dataType] of CLAIMS_COLUMNS) {
      const state = await columnState('scaler_pending_claims', col);
      expect(state.exists, `${col} missing`).toBe(true);
      expect(state.dataType, `${col} has the wrong type`).toBe(dataType);
    }
    // CLAIMS_COLUMNS is the whole table, not a sample of it — so a column added
    // to the migration without a matching row here fails rather than going
    // unasserted.
    const actual = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'scaler_pending_claims'
       ORDER BY column_name
    `.execute(db);
    expect(actual.rows.map((r) => r.column_name)).toEqual(
      CLAIMS_COLUMNS.map(([c]) => c).sort((a, b) => a.localeCompare(b)),
    );
  });

  it('makes consumed_at the nullable single-use marker', async () => {
    const state = await columnState('scaler_pending_claims', 'consumed_at');
    expect(state.exists).toBe(true);
    expect(state.nullable).toBe(true);
    // Every other claims column is NOT NULL, so an unredeemed claim is the only
    // row shape carrying a NULL.
    for (const [col] of CLAIMS_COLUMNS.filter(([c]) => c !== 'consumed_at')) {
      expect((await columnState('scaler_pending_claims', col)).nullable, `${col} is nullable`).toBe(
        false,
      );
    }
  });

  it('adds the self-describing ownership columns to scaler_spawning_agents', async () => {
    for (const [col, dataType] of SPAWNING_COLUMNS) {
      const state = await columnState('scaler_spawning_agents', col);
      expect(state.exists, `${col} missing`).toBe(true);
      expect(state.dataType, `${col} has the wrong type`).toBe(dataType);
      expect(state.nullable, `${col} must be nullable so existing rows backfill as NULL`).toBe(
        true,
      );
    }
  });

  it('adds owner_instance_id to scaler_reservations', async () => {
    const state = await columnState('scaler_reservations', 'owner_instance_id');
    expect(state.exists).toBe(true);
    expect(state.nullable).toBe(true);
    expect(state.dataType).toBe('text');
  });

  it('is idempotent on a re-run', async () => {
    await up(db);
    await up(db);
    const state = await columnState('scaler_spawning_agents', 'adopted_by');
    expect(state.exists).toBe(true);
  });

  it('down() drops the new objects and up() restores them', async () => {
    expect(await indexExists('idx_scaler_spawning_agents_scaler_name')).toBe(true);

    await down(db);
    expect((await columnState('scaler_pending_claims', 'consumed_at')).exists).toBe(false);
    expect((await columnState('scaler_spawning_agents', 'adopted_by')).exists).toBe(false);
    expect((await columnState('scaler_reservations', 'owner_instance_id')).exists).toBe(false);
    // `scaler_name` pre-dates 119, so its index is the one down() has to drop
    // explicitly — the column-drop loop cannot take it along.
    expect(await indexExists('idx_scaler_spawning_agents_scaler_name')).toBe(false);
    // Migration 022's own index on the same table must survive the rollback.
    expect(await indexExists('idx_scaler_spawning_agents_spawned_at')).toBe(true);

    await up(db);
    expect((await columnState('scaler_pending_claims', 'consumed_at')).exists).toBe(true);
    for (const [col] of SPAWNING_COLUMNS) {
      expect((await columnState('scaler_spawning_agents', col)).exists, `${col} missing`).toBe(
        true,
      );
    }
    expect((await columnState('scaler_reservations', 'owner_instance_id')).exists).toBe(true);
    expect(await indexExists('idx_scaler_spawning_agents_scaler_name')).toBe(true);
  });
});
