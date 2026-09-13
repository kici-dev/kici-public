import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './072_dispatch_queue_run_id_index.js';
import type { Database } from '../types.js';
import { JobQueue, DispatchQueueStatus } from '../../queue/job-queue.js';

/**
 * Real-Postgres test for migration 072. Creates a throwaway database, applies
 * migrations 001..072, and asserts `idx_dispatch_queue_run_id` exists after up()
 * and is gone after down() (then recreated idempotently). A second block proves
 * `pruneTerminalDispatchRows` deletes only terminal rows past the retention
 * window, never a non-terminal or in-window row. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig072_test_${process.pid}_${Date.now()}`;
const INDEX = 'idx_dispatch_queue_run_id';

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 072_dispatch_queue_run_id_index', () => {
  let db: Kysely<Database>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const indexExists = async (): Promise<boolean> => {
    const result = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = ${INDEX}
      ) AS exists
    `.execute(db);
    return Boolean(result.rows[0]?.exists);
  };

  const insertRow = async (
    runId: string,
    status: DispatchQueueStatus,
    createdAt: Date,
  ): Promise<void> => {
    await db
      .insertInto('dispatch_queue')
      .values({
        run_id: runId,
        workflow_name: 'ci',
        job_name: 'build',
        runs_on_labels: JSON.stringify(['linux']),
        job_config: '{}',
        repo_url: 'https://example.com/o/r.git',
        ref: 'refs/heads/main',
        sha: 'deadbeef',
        status,
        created_at: createdAt,
        delivery_id: `d-${runId}-${status}`,
        routing_key: 'github:1',
      })
      .execute();
  };

  beforeAll(async () => {
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
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

  it('creates idx_dispatch_queue_run_id (the beforeAll migration ran it)', async () => {
    expect(await indexExists()).toBe(true);
  });

  it('down() drops the index; up() recreates it idempotently', async () => {
    await down(db as unknown as Kysely<unknown>);
    expect(await indexExists()).toBe(false);
    await up(db as unknown as Kysely<unknown>);
    await up(db as unknown as Kysely<unknown>); // idempotent (IF NOT EXISTS)
    expect(await indexExists()).toBe(true);
  });

  it('pruneTerminalDispatchRows deletes only terminal rows past the window', async () => {
    await db.deleteFrom('dispatch_queue').execute();
    const now = Date.now();
    const daysAgo = (d: number) => new Date(now - d * 86_400_000);
    // Old terminal rows → pruned.
    await insertRow('run-old-completed', DispatchQueueStatus.Completed, daysAgo(40));
    await insertRow('run-old-failed', DispatchQueueStatus.Failed, daysAgo(40));
    await insertRow('run-old-expired', DispatchQueueStatus.Expired, daysAgo(40));
    // A still-active run: old but non-terminal → KEPT.
    await insertRow('run-old-pending', DispatchQueueStatus.Pending, daysAgo(40));
    await insertRow('run-old-dispatched', DispatchQueueStatus.Dispatched, daysAgo(40));
    await insertRow('run-old-recovering', DispatchQueueStatus.Recovering, daysAgo(40));
    // A recently-terminal run inside the window → KEPT.
    await insertRow('run-recent-completed', DispatchQueueStatus.Completed, daysAgo(1));

    const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });
    const deleted = await queue.pruneTerminalDispatchRows(30);
    expect(deleted).toBe(3);

    const remaining = await db.selectFrom('dispatch_queue').select(['run_id', 'status']).execute();
    expect(remaining.map((r) => r.run_id).sort()).toEqual(
      [
        'run-old-dispatched',
        'run-old-pending',
        'run-old-recovering',
        'run-recent-completed',
      ].sort(),
    );
  });

  it('pruneTerminalDispatchRows is a no-op when retentionDays <= 0', async () => {
    await db.deleteFrom('dispatch_queue').execute();
    await insertRow(
      'run-x',
      DispatchQueueStatus.Completed,
      new Date(Date.now() - 999 * 86_400_000),
    );
    const queue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });
    expect(await queue.pruneTerminalDispatchRows(0)).toBe(0);
    const count = await db
      .selectFrom('dispatch_queue')
      .select(db.fn.countAll<number>().as('c'))
      .executeTakeFirst();
    expect(Number(count?.c)).toBe(1);
  });
});
