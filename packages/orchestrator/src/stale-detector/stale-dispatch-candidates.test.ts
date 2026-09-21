import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ExecutionJobStatus, ExecutionRunStatus } from '@kici-dev/engine';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import pg from 'pg';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { DispatchQueueStatus } from '../queue/job-queue.js';
import { selectStaleDispatchCandidates } from './stale-dispatch-candidates.js';
import { terminateTestDbBackends } from '../__test-helpers__/test-db.js';

/**
 * Real-Postgres tests for the stale-dispatch sub-scan's three predicates.
 *
 * They are raw SQL — a `COALESCE` over two columns, and an acked-dispatch
 * exemption — so a mock records them without evaluating them, and the bug they
 * fix was invisible for exactly that reason: the scan keyed on `created_at`
 * (enqueue) rather than `dispatched_at`, so it read "enqueued more than two
 * minutes ago and not yet running" and reaped every job that had waited behind
 * a busy fleet.
 *
 * Gated on KICI_TEST_ADMIN_DATABASE_URL; the shared vitest globalSetup
 * (scripts/db-test-postgres.ts) supplies it by starting a throwaway container.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_stale_dispatch_test_${process.pid}_${Date.now()}`;

const RUN_ID = '33333333-3333-4333-8333-333333333333';
const MINUTE = 60_000;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('selectStaleDispatchCandidates (real Postgres)', () => {
  let pool: pg.Pool;
  let db: Kysely<Database>;
  const adminUrl = ADMIN_URL!;

  /** `now - 2min` / `now - 30min`, the detector's own bounds. */
  const threshold = (): Date => new Date(Date.now() - 2 * MINUTE);
  const timeBound = (): Date => new Date(Date.now() - 30 * MINUTE);

  const insertDispatch = async (opts: {
    jobName: string;
    createdMinutesAgo: number;
    dispatchedMinutesAgo?: number;
    ackDeadline?: Date | null;
    ackAgentId?: string | null;
  }): Promise<void> => {
    const created = new Date(Date.now() - opts.createdMinutesAgo * MINUTE);
    const dispatched =
      opts.dispatchedMinutesAgo === undefined
        ? null
        : new Date(Date.now() - opts.dispatchedMinutesAgo * MINUTE);
    await sql`
      INSERT INTO public.dispatch_queue
        (run_id, workflow_name, job_name, runs_on_labels, job_config, repo_url, ref, sha,
         delivery_id, routing_key, status, created_at, dispatched_at, ack_deadline, ack_agent_id)
      VALUES (${RUN_ID}, 'ci', ${opts.jobName}, '[]', '{}', 'https://x/y', 'main', 'abc',
              ${opts.jobName}, 'rk', ${DispatchQueueStatus.Dispatched}, ${created}, ${dispatched},
              ${opts.ackDeadline ?? null}, ${opts.ackAgentId ?? null})
    `.execute(db);
  };

  const candidateNames = async (): Promise<string[]> => {
    const rows = await selectStaleDispatchCandidates(db, threshold(), timeBound());
    return rows.map((r) => r.job_name).sort();
  };

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    const { error } = await new Migrator({
      db,
      provider: createMigrationProvider(),
    }).migrateToLatest();
    if (error) throw error;
    await sql`
      INSERT INTO public.execution_runs
        (run_id, workflow_name, provider, repo_identifier, ref, sha, status)
      VALUES (${RUN_ID}::uuid, 'ci', 'github', 'owner/repo', 'main', 'abc',
              ${ExecutionRunStatus.enum.running})
    `.execute(db);
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await terminateTestDbBackends(admin, TEST_DB);
      await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  afterEach(async () => {
    await sql`TRUNCATE TABLE dispatch_queue`.execute(db);
    await sql`DELETE FROM execution_jobs`.execute(db);
  });

  it('spares a job enqueued 5 minutes ago but dispatched 30 seconds ago', async () => {
    // The scaler cold-start case: the job waited behind a busy fleet, then an
    // agent claimed it and started cloning. Keyed on `created_at` this was
    // reaped while the agent ran it to completion for nothing.
    await insertDispatch({
      jobName: 'fresh-dispatch',
      createdMinutesAgo: 5,
      dispatchedMinutesAgo: 0.5,
      ackDeadline: new Date(Date.now() + MINUTE),
      ackAgentId: 'agent-1',
    });

    expect(await candidateNames()).toEqual([]);
  });

  it('reaps a job dispatched 3 minutes ago that never acked', async () => {
    await insertDispatch({
      jobName: 'never-acked',
      createdMinutesAgo: 10,
      dispatchedMinutesAgo: 3,
      ackDeadline: new Date(Date.now() - MINUTE),
      ackAgentId: 'agent-1',
    });

    expect(await candidateNames()).toEqual(['never-acked']);
  });

  it('never reaps a dispatch whose ack landed', async () => {
    // The ack path clears `ack_deadline` and leaves `ack_agent_id` stamped, so
    // that pairing is the durable record that the agent answered. It owns the
    // job from there; the heartbeat sub-scans cover it going quiet later.
    await insertDispatch({
      jobName: 'acked',
      createdMinutesAgo: 10,
      dispatchedMinutesAgo: 5,
      ackDeadline: null,
      ackAgentId: 'agent-1',
    });

    expect(await candidateNames()).toEqual([]);
  });

  it('keeps the previous behaviour for a pre-migration row with no dispatch time', async () => {
    // The rolling-upgrade bridge: NULL `dispatched_at` falls back to
    // `created_at`, so a row a pre-upgrade coordinator dispatched is still
    // reachable — which is what makes sparing an unknown-owner row safe.
    await insertDispatch({ jobName: 'legacy', createdMinutesAgo: 5 });

    expect(await candidateNames()).toEqual(['legacy']);
  });

  it('respects the lower time bound on the dispatch clock', async () => {
    await insertDispatch({
      jobName: 'ancient',
      createdMinutesAgo: 120,
      dispatchedMinutesAgo: 90,
    });

    expect(await candidateNames()).toEqual([]);
  });

  it('spares a job the agent already reported running', async () => {
    await insertDispatch({
      jobName: 'running-job',
      createdMinutesAgo: 10,
      dispatchedMinutesAgo: 5,
    });
    await sql`
      INSERT INTO public.execution_jobs (run_id, job_id, job_name, status)
      VALUES (${RUN_ID}::uuid, 'job-running', 'running-job', ${ExecutionJobStatus.enum.running})
    `.execute(db);

    expect(await candidateNames()).toEqual([]);
  });
});
