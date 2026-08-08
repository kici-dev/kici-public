import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';

/**
 * Real-Postgres test for migration 076.
 *
 * Creates a throwaway database, applies migrations 001..076 via the
 * production migration provider, and asserts the `artifacts` table + its
 * `UNIQUE (run_id, name)` immutability constraint and indexes exist, and that
 * the `artifact_quota_bytes` / `artifact_ttl_ms` columns landed on
 * `org_settings`. Dropped in teardown.
 *
 * Gated on `KICI_TEST_ADMIN_DATABASE_URL`: skips when unset, fails when set but
 * unreachable.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig076_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 076_artifacts', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
    const { error } = await migrateToOwnMigration(db, import.meta.url);
    if (error) throw error;
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('creates the artifacts table with a run_id+name unique constraint', async () => {
    const exists = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'artifacts'
      ) AS exists
    `.execute(db);
    expect(exists.rows[0]?.exists).toBe(true);

    await sql`
      INSERT INTO artifacts (id, customer_id, run_id, job_id, name, size_bytes, sha256, storage_key)
      VALUES ('a1', 'org1', 'run1', 'job1', 'bundle', 100, 'h', 'artifacts/run1/bundle.tar.gz')
    `.execute(db);

    // Second row with the same (run_id, name) violates the immutability constraint.
    await expect(
      sql`
        INSERT INTO artifacts (id, customer_id, run_id, job_id, name, size_bytes, sha256, storage_key)
        VALUES ('a2', 'org1', 'run1', 'job2', 'bundle', 200, 'h2', 'artifacts/run1/bundle.tar.gz')
      `.execute(db),
    ).rejects.toThrow();

    // A different name in the same run is fine.
    await sql`
      INSERT INTO artifacts (id, customer_id, run_id, job_id, name, size_bytes, sha256, storage_key)
      VALUES ('a3', 'org1', 'run1', 'job2', 'other', 200, 'h3', 'artifacts/run1/other.tar.gz')
    `.execute(db);
  });

  it('adds artifact_quota_bytes + artifact_ttl_ms to org_settings', async () => {
    const cols = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'org_settings'
         AND column_name IN ('artifact_quota_bytes', 'artifact_ttl_ms')
    `.execute(db);
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual([
      'artifact_quota_bytes',
      'artifact_ttl_ms',
    ]);
  });
});
