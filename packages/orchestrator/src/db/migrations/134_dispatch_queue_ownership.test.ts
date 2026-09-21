import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './134_dispatch_queue_ownership.js';
import { terminateTestDbBackends } from '../../__test-helpers__/test-db.js';

/**
 * Real-Postgres test for migration 134: asserts the two `dispatch_queue`
 * ownership columns, the `cluster_instances` heartbeat table and the
 * `concurrency_groups` partial unique index exist after migrations 001..134,
 * and that up/down are idempotent. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 *
 * Nullability is the load-bearing part for both columns. A row queued before
 * this migration has no owner and no dispatch timestamp, and no cluster-wide
 * value could stand in for either: a stamped owner would be a lie, and a
 * stamped dispatch time would move a real deadline. NULL is what lets an
 * in-flight queue survive a rolling upgrade — an unknown-owner row is spared by
 * recovery rather than failed, and a NULL `dispatched_at` falls back to
 * `created_at`, which is exactly the previous behaviour.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig134_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 134_dispatch_queue_ownership', () => {
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

  const indexExists = async (name: string): Promise<boolean> => {
    const r = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = ${name}
      ) AS exists
    `.execute(db);
    return r.rows[0]?.exists ?? false;
  };

  const tableExists = async (name: string): Promise<boolean> => {
    const r = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ${name}
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
      await terminateTestDbBackends(adminPool, TEST_DB);
      await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
  }, 60_000);

  it('adds owner_instance_id as nullable text with no default', async () => {
    const state = await columnState('dispatch_queue', 'owner_instance_id');
    expect(state.exists).toBe(true);
    expect(state.dataType).toBe('text');
    expect(state.nullable).toBe(true);
    expect(state.columnDefault).toBeNull();
  });

  it('adds dispatched_at as a nullable timestamptz with no default', async () => {
    const state = await columnState('dispatch_queue', 'dispatched_at');
    expect(state.exists).toBe(true);
    expect(state.dataType).toBe('timestamp with time zone');
    expect(state.nullable).toBe(true);
    expect(state.columnDefault).toBeNull();
  });

  it('leaves a pre-migration-shaped row with a NULL owner and a NULL dispatch time', async () => {
    await sql`
      INSERT INTO public.dispatch_queue
        (run_id, workflow_name, job_name, runs_on_labels, job_config, repo_url, ref, sha,
         delivery_id, routing_key)
      VALUES ('run-1', 'mig134-legacy', 'j', '[]', '{}', 'https://x/y', 'main', 'sha1',
              'd1', 'rk')
    `.execute(db);
    const r = await sql<{ owner_instance_id: string | null; dispatched_at: Date | null }>`
      SELECT owner_instance_id, dispatched_at FROM public.dispatch_queue
       WHERE workflow_name = 'mig134-legacy'
    `.execute(db);
    expect(r.rows[0]?.owner_instance_id).toBeNull();
    expect(r.rows[0]?.dispatched_at).toBeNull();
  });

  it('creates the cluster_instances heartbeat table with defaulted timestamps', async () => {
    expect(await tableExists('cluster_instances')).toBe(true);
    await sql`
      INSERT INTO public.cluster_instances (instance_id, role, version)
      VALUES ('coord-a', 'leader', '0.7.0')
    `.execute(db);
    const r = await sql<{ started_at: Date; last_heartbeat_at: Date; role: string | null }>`
      SELECT started_at, last_heartbeat_at, role FROM public.cluster_instances
       WHERE instance_id = 'coord-a'
    `.execute(db);
    expect(r.rows[0]?.role).toBe('leader');
    expect(r.rows[0]?.started_at).toBeInstanceOf(Date);
    expect(r.rows[0]?.last_heartbeat_at).toBeInstanceOf(Date);
  });

  it('makes an active concurrency slot unique per (routing_key, group_key, run_id)', async () => {
    expect(await indexExists('idx_concurrency_groups_active_unique')).toBe(true);
    const runId = '11111111-1111-4111-8111-111111111111';
    const jobId = '22222222-2222-4222-8222-222222222222';
    const insertActive = () =>
      sql`
      INSERT INTO public.concurrency_groups (group_key, run_id, job_id, routing_key, status)
      VALUES ('deploy', ${runId}::uuid, ${jobId}::uuid, 'rk-134', 'active')
    `.execute(db);

    await insertActive();
    await expect(insertActive()).rejects.toThrow();

    // The index is partial, so a completed row for the same scope is allowed —
    // a run that released its slot must not block the next acquire.
    await sql`
      INSERT INTO public.concurrency_groups (group_key, run_id, job_id, routing_key, status)
      VALUES ('deploy', ${runId}::uuid, ${jobId}::uuid, 'rk-134', 'completed')
    `.execute(db);
  });

  it('down() drops every object and up() restores them, idempotently', async () => {
    await down(db);
    expect((await columnState('dispatch_queue', 'owner_instance_id')).exists).toBe(false);
    expect((await columnState('dispatch_queue', 'dispatched_at')).exists).toBe(false);
    expect(await tableExists('cluster_instances')).toBe(false);
    expect(await indexExists('idx_concurrency_groups_active_unique')).toBe(false);

    // Clear the rows the previous test left so the re-created index is asserted
    // on an empty scope rather than on whatever survived it.
    await sql`DELETE FROM public.concurrency_groups WHERE routing_key = 'rk-134'`.execute(db);

    await up(db);
    await up(db); // idempotent
    expect((await columnState('dispatch_queue', 'owner_instance_id')).exists).toBe(true);
    expect((await columnState('dispatch_queue', 'dispatched_at')).exists).toBe(true);
    expect(await tableExists('cluster_instances')).toBe(true);
    expect(await indexExists('idx_concurrency_groups_active_unique')).toBe(true);
  });

  it('collapses pre-existing duplicate active slots instead of failing the index build', async () => {
    // The shape an upgraded database is actually in: the slot was recorded once
    // per `concurrency.report`, and a report arrives per JOB, so a run with two
    // jobs in one group left two `active` rows for one scope. Building the
    // unique index over that fails, and a failed migration is a failed startup.
    const runId = '55555555-5555-4555-8555-555555555555';
    const older = '66666666-6666-4666-8666-666666666666';
    const newer = '77777777-7777-4777-8777-777777777777';
    await down(db);
    await sql`
      INSERT INTO public.concurrency_groups
        (group_key, run_id, job_id, routing_key, status, created_at)
      VALUES ('deploy', ${runId}::uuid, ${older}::uuid, 'rk-dup', 'active', NOW() - INTERVAL '1 hour'),
             ('deploy', ${runId}::uuid, ${newer}::uuid, 'rk-dup', 'active', NOW())
    `.execute(db);

    await up(db);

    expect(await indexExists('idx_concurrency_groups_active_unique')).toBe(true);
    const rows = await sql<{ job_id: string; status: string; completed_at: Date | null }>`
      SELECT job_id, status, completed_at FROM public.concurrency_groups
       WHERE routing_key = 'rk-dup' ORDER BY created_at ASC
    `.execute(db);
    // The oldest row is the slot the run actually holds; the rest are records of
    // the same acquisition and are completed, not deleted.
    expect(rows.rows.map((r) => [r.job_id, r.status])).toEqual([
      [older, 'active'],
      [newer, 'completed'],
    ]);
    expect(rows.rows[1]?.completed_at).toBeInstanceOf(Date);
  });
});
