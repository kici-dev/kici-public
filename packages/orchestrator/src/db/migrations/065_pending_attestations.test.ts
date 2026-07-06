import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../migration-provider.js';
import { down, up } from './065_pending_attestations.js';

/**
 * Real-Postgres test for migration 065. Creates a throwaway database, runs every
 * migration to latest, and asserts the pending_attestations table + its columns
 * exist and the attestations idempotency index is present. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig065_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 065_pending_attestations', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const tableExists = async (name: string): Promise<boolean> => {
    const result = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ${name}
      ) AS exists
    `.execute(db);
    return result.rows[0]?.exists ?? false;
  };

  const columns = async (): Promise<string[]> => {
    const result = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'pending_attestations'
    `.execute(db);
    return result.rows.map((r) => r.column_name).sort();
  };

  const indexExists = async (table: string, index: string): Promise<boolean> => {
    const result = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes WHERE tablename = ${table} AND indexname = ${index}
    `.execute(db);
    return result.rows.length === 1;
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
    const { error } = await new Migrator({
      db,
      provider: createMigrationProvider(),
    }).migrateToLatest();
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

  it('creates pending_attestations with the expected columns and unique index', async () => {
    expect(await tableExists('pending_attestations')).toBe(true);
    expect(await columns()).toEqual(
      [
        'attempt_count',
        'audience',
        'created_at',
        'dsse_envelope',
        'id',
        'job_id',
        'last_attempt_at',
        'last_error',
        'media_type',
        'origin_kind',
        'public_key',
        'rejected_at',
        'run_id',
        'statement_hash',
        'subject_digest',
        'subject_name',
      ].sort(),
    );
    expect(await indexExists('attestations', 'uq_attestations_run_job_subject')).toBe(true);
  });

  it('down() drops the table + index; up() recreates idempotently', async () => {
    await down(db);
    expect(await tableExists('pending_attestations')).toBe(false);
    await up(db);
    await up(db); // idempotent (existence guard)
    expect(await tableExists('pending_attestations')).toBe(true);
    expect(await indexExists('attestations', 'uq_attestations_run_job_subject')).toBe(true);
  });
});
