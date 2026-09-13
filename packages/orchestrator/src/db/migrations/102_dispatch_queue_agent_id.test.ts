import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './102_dispatch_queue_agent_id.js';

/**
 * Real-Postgres test for migration 102: asserts `dispatch_queue.agent_id`
 * exists as a nullable text column after migrations 001..102, that a dispatched
 * row round-trips its owning agent, and that up/down are idempotent. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig102_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 102_dispatch_queue_agent_id', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columnState = async (
    col: string,
  ): Promise<{ exists: boolean; nullable: boolean; dataType: string }> => {
    const r = await sql<{ is_nullable: string; data_type: string }>`
      SELECT is_nullable, data_type FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'dispatch_queue'
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

  it('adds a nullable text agent_id column', async () => {
    const state = await columnState('agent_id');
    expect(state.exists).toBe(true);
    expect(state.nullable).toBe(true);
    expect(state.dataType).toBe('text');
  });

  it('round-trips the owning agent on a dispatched row', async () => {
    await sql`
      INSERT INTO public.dispatch_queue
        (id, run_id, workflow_name, job_name, runs_on_labels, job_config,
         repo_url, ref, sha, status, delivery_id, routing_key, agent_id)
      VALUES
        ('11111111-1111-1111-1111-111111111111', 'run-102', 'wf', 'job',
         '[]'::jsonb, '{}', 'https://example.com/r.git', 'refs/heads/main',
         'deadbeef', 'dispatched', 'delivery-102', 'generic:102', 'agent-102')
    `.execute(db);
    const r = await sql<{ agent_id: string | null }>`
      SELECT agent_id FROM public.dispatch_queue
       WHERE id = '11111111-1111-1111-1111-111111111111'
    `.execute(db);
    expect(r.rows[0]?.agent_id).toBe('agent-102');
  });

  it('down() drops the column and up() restores it', async () => {
    await down(db);
    expect((await columnState('agent_id')).exists).toBe(false);
    await up(db);
    await up(db); // idempotent
    expect((await columnState('agent_id')).exists).toBe(true);
  });
});
