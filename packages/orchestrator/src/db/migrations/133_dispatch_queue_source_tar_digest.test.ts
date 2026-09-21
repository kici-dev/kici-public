import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './133_dispatch_queue_source_tar_digest.js';
import { terminateTestDbBackends } from '../../__test-helpers__/test-db.js';

/**
 * Real-Postgres test for migration 133: asserts `dispatch_queue.source_tar_digest`
 * exists as a nullable text column with no default after migrations 001..133,
 * and that up/down are idempotent. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 *
 * Nullability is the load-bearing part: every row queued before this column
 * existed has no digest, and no cluster-wide value could stand in for one. The
 * agent reads NULL as "nothing to verify against" and restores unverified, so
 * an in-flight queue survives the upgrade rather than failing every job.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig133_test_${process.pid}_${Date.now()}`;

const COLUMN = 'source_tar_digest';

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 133_dispatch_queue_source_tar_digest', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columnState = async (
    table: string,
    col: string,
  ): Promise<{
    exists: boolean;
    nullable: boolean;
    dataType: string;
    columnDefault: string | null;
  }> => {
    const r = await sql<{ is_nullable: string; data_type: string; column_default: string | null }>`
      SELECT is_nullable, data_type, column_default FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ${table}
         AND column_name = ${col}
    `.execute(db);
    const row = r.rows[0];
    return {
      exists: row !== undefined,
      nullable: row?.is_nullable === 'YES',
      dataType: row?.data_type ?? '',
      columnDefault: row?.column_default ?? null,
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
      await terminateTestDbBackends(adminPool, TEST_DB);
      await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
  }, 60_000);

  it('adds the column as nullable text with no default', async () => {
    const state = await columnState('dispatch_queue', COLUMN);
    expect(state.exists).toBe(true);
    expect(state.dataType).toBe('text');
    expect(state.nullable).toBe(true);
    expect(state.columnDefault).toBeNull();
  });

  it('leaves a job queued without a digest NULL', async () => {
    await sql`
      INSERT INTO public.dispatch_queue
        (run_id, workflow_name, job_name, runs_on_labels, job_config, repo_url, ref, sha,
         delivery_id, routing_key)
      VALUES ('run-1', 'mig133-nodigest', 'j', '[]', '{}', 'https://x/y', 'main', 'sha1',
              'd1', 'rk')
    `.execute(db);
    const r = await sql<{ source_tar_digest: string | null }>`
      SELECT source_tar_digest FROM public.dispatch_queue
       WHERE workflow_name = 'mig133-nodigest'
    `.execute(db);
    expect(r.rows[0]?.source_tar_digest).toBeNull();
  });

  it('stores the tarball digest alongside the contentHash-bearing source_tar_hash', async () => {
    await sql`
      INSERT INTO public.dispatch_queue
        (run_id, workflow_name, job_name, runs_on_labels, job_config, repo_url, ref, sha,
         delivery_id, routing_key, source_tar_hash, source_tar_digest)
      VALUES ('run-2', 'mig133-digest', 'j', '[]', '{}', 'https://x/y', 'main', 'sha1',
              'd2', 'rk', 'contenthash', 'tarballdigest')
    `.execute(db);
    const r = await sql<{ source_tar_hash: string | null; source_tar_digest: string | null }>`
      SELECT source_tar_hash, source_tar_digest FROM public.dispatch_queue
       WHERE workflow_name = 'mig133-digest'
    `.execute(db);
    expect(r.rows[0]?.source_tar_hash).toBe('contenthash');
    expect(r.rows[0]?.source_tar_digest).toBe('tarballdigest');
  });

  it('down() drops it and up() restores it, idempotently', async () => {
    await down(db);
    expect((await columnState('dispatch_queue', COLUMN)).exists).toBe(false);

    await up(db);
    await up(db); // idempotent
    expect((await columnState('dispatch_queue', COLUMN)).exists).toBe(true);
  });
});
