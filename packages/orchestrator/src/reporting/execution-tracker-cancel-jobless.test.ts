import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { ExecutionJobStatus, ExecutionRunStatus, RunFailureClass } from '@kici-dev/engine';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { ExecutionTracker, type TrackedJobRow } from './execution-tracker.js';
import { terminateTestDbBackends } from '../__test-helpers__/test-db.js';

/**
 * Real-Postgres coverage for `cancelJoblessRun`. Its job-row guard is a raw
 * correlated `NOT EXISTS` over `execution_jobs`, which only a real database
 * evaluates. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_cancel_jobless_${process.pid}_${Date.now()}`;

const REASON = 'run cancelled via API';

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('ExecutionTracker.cancelJoblessRun against a real database', () => {
  let db: Kysely<Database>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  beforeAll(async () => {
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    const migrator = new Migrator({ db, provider: createMigrationProvider() });
    const { error } = await migrator.migrateToLatest();
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

  function start(tracker: ExecutionTracker, runId: string, jobs: TrackedJobRow[]): Promise<void> {
    return tracker.onExecutionStarted(
      runId,
      'build',
      'github',
      'acme/app',
      'main',
      'headsha',
      null,
      {},
      null,
      jobs,
      'github:1',
    );
  }

  async function runRow(runId: string) {
    return db
      .selectFrom('execution_runs')
      .select(['status', 'failure_reason', 'failure_class', 'completed_at'])
      .where('run_id', '=', runId)
      .executeTakeFirstOrThrow();
  }

  it('cancels a pending run with no job rows and forwards the cancelled frame', async () => {
    const onExecutionStatusChange = vi.fn();
    const onRunTerminalCleanup = vi.fn();
    const tracker = new ExecutionTracker({ db, onExecutionStatusChange, onRunTerminalCleanup });
    const runId = randomUUID();
    await start(tracker, runId, []);
    // Control: the start wrote a pending row and no job row.
    expect((await runRow(runId)).status).toBe(ExecutionRunStatus.enum.pending);

    const cancelled = await tracker.cancelJoblessRun(runId, REASON);

    // fails-when: the NOT EXISTS guard is mis-correlated to a column that never matches the run
    expect(cancelled).toBe(true);
    expect(await runRow(runId)).toMatchObject({
      status: ExecutionRunStatus.enum.cancelled,
      failure_reason: REASON,
      failure_class: RunFailureClass.enum.cancelled,
    });
    expect((await runRow(runId)).completed_at).not.toBeNull();
    expect(onRunTerminalCleanup).toHaveBeenCalledWith(runId);
    expect(onExecutionStatusChange).toHaveBeenCalledWith(
      runId,
      ExecutionRunStatus.enum.cancelled,
      expect.objectContaining({ workflowName: 'build', repoIdentifier: 'acme/app' }),
      0,
      expect.any(Number),
      expect.any(Number),
      0,
      REASON,
    );
  });

  it('leaves a pending run that has a job row untouched', async () => {
    const onExecutionStatusChange = vi.fn();
    const tracker = new ExecutionTracker({ db, onExecutionStatusChange });
    const runId = randomUUID();
    const jobId = randomUUID();
    await start(tracker, runId, [{ jobId, jobName: 'compile' }]);
    // Control: the job row really exists, so the guard has something to see.
    const jobRow = await db
      .selectFrom('execution_jobs')
      .select(['status'])
      .where('run_id', '=', runId)
      .where('job_id', '=', jobId)
      .executeTakeFirstOrThrow();
    expect(jobRow.status).toBe(ExecutionJobStatus.enum.pending);

    const cancelled = await tracker.cancelJoblessRun(runId, REASON);

    // fails-when: the NOT EXISTS execution_jobs guard is dropped, so the run is cancelled
    // under a job that will still report its own terminal status
    expect(cancelled).toBe(false);
    expect(await runRow(runId)).toMatchObject({
      status: ExecutionRunStatus.enum.pending,
      failure_reason: null,
    });
    expect(onExecutionStatusChange.mock.calls.map((call) => call[1])).not.toContain(
      ExecutionRunStatus.enum.cancelled,
    );
  });

  it('keeps the cancellation reason already stamped on the row', async () => {
    const tracker = new ExecutionTracker({ db });
    const runId = randomUUID();
    await start(tracker, runId, []);
    await db
      .updateTable('execution_runs')
      .set({ failure_reason: 'run cancelled by alice' })
      .where('run_id', '=', runId)
      .execute();

    expect(await tracker.cancelJoblessRun(runId, REASON)).toBe(true);

    // fails-when: the COALESCE is dropped and the generic reason overwrites the specific one
    expect((await runRow(runId)).failure_reason).toBe('run cancelled by alice');
  });

  it('leaves a held run to the hold-rejection path', async () => {
    const tracker = new ExecutionTracker({ db });
    const runId = randomUUID();
    await tracker.recordRunHeld({
      runId,
      workflowName: 'build',
      provider: 'github',
      repoIdentifier: 'acme/app',
      workflowRepoIdentifier: 'acme/app',
      ref: 'main',
      sha: 'headsha',
      deliveryId: null,
      providerContext: {},
      routingKey: 'github:1',
      reason: 'fork_pr',
    });

    // fails-when: the status guard admits `held`, so the row is cancelled while its hold
    // and its pending security check stay live
    expect(await tracker.cancelJoblessRun(runId, REASON)).toBe(false);
    expect((await runRow(runId)).status).toBe(ExecutionRunStatus.enum.held);
  });

  it('does not touch a run that is already terminal', async () => {
    const tracker = new ExecutionTracker({ db });
    const runId = randomUUID();
    await start(tracker, runId, []);
    await db
      .updateTable('execution_runs')
      .set({ status: ExecutionRunStatus.enum.success })
      .where('run_id', '=', runId)
      .execute();

    // fails-when: the non-terminal guard is dropped and a finished run is rewritten
    expect(await tracker.cancelJoblessRun(runId, REASON)).toBe(false);
    expect((await runRow(runId)).status).toBe(ExecutionRunStatus.enum.success);
  });
});
