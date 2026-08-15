import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './114_ingest_queue_claim.js';

/**
 * Real-Postgres test for migration 114: asserts both claim-bookkeeping columns
 * exist with the right nullability and types after migrations 001..114, and
 * that up/down are idempotent. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig114_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 114_ingest_queue_claim', () => {
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

  it('adds both nullable columns with the right types', async () => {
    const claimedAt = await columnState('ingest_overflow_buffer', 'claimed_at');
    expect(claimedAt.exists).toBe(true);
    expect(claimedAt.nullable).toBe(true);
    expect(claimedAt.dataType).toBe('timestamp with time zone');

    const timeout = await columnState('cluster_settings', 'ingest_overflow_claim_timeout_ms');
    expect(timeout.exists).toBe(true);
    expect(timeout.nullable).toBe(true);
    expect(timeout.dataType).toBe('integer');
  });

  it('round-trips a stored ingest_overflow_claim_timeout_ms', async () => {
    await sql`
      INSERT INTO public.cluster_settings (id, ingest_overflow_claim_timeout_ms)
      VALUES ('default', 900000)
      ON CONFLICT (id) DO UPDATE
        SET ingest_overflow_claim_timeout_ms = EXCLUDED.ingest_overflow_claim_timeout_ms
    `.execute(db);
    const r = await sql<{ ingest_overflow_claim_timeout_ms: string | number | null }>`
      SELECT ingest_overflow_claim_timeout_ms FROM public.cluster_settings WHERE id = 'default'
    `.execute(db);
    expect(Number(r.rows[0]?.ingest_overflow_claim_timeout_ms)).toBe(900000);
  });

  it('round-trips a claimed_at stamp on a buffered row', async () => {
    await sql`
      INSERT INTO public.ingest_overflow_buffer
        (delivery_id, routing_key, source_kind, event, body, status, claimed_at)
      VALUES ('mig114-delivery', 'github:1', 'direct', 'push', 'e30=', 'replaying', now())
    `.execute(db);
    const r = await sql<{ claimed_at: Date | null }>`
      SELECT claimed_at FROM public.ingest_overflow_buffer WHERE delivery_id = 'mig114-delivery'
    `.execute(db);
    expect(r.rows[0]?.claimed_at).toBeInstanceOf(Date);
  });

  it('is idempotent on up and down', async () => {
    await up(db);
    await up(db);
    await down(db);
    expect((await columnState('ingest_overflow_buffer', 'claimed_at')).exists).toBe(false);
    expect((await columnState('cluster_settings', 'ingest_overflow_claim_timeout_ms')).exists).toBe(
      false,
    );
    await down(db);
    await up(db);
    expect((await columnState('ingest_overflow_buffer', 'claimed_at')).exists).toBe(true);
    expect((await columnState('cluster_settings', 'ingest_overflow_claim_timeout_ms')).exists).toBe(
      true,
    );
  });
});
