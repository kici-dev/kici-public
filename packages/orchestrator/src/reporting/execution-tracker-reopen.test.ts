import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { ExecutionJobStatus, ExecutionRunStatus } from '@kici-dev/engine';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { ExecutionTracker } from './execution-tracker.js';
import { terminateTestDbBackends } from '../__test-helpers__/test-db.js';

/**
 * Real-Postgres coverage for the reopen of a prematurely failed run. The reopen
 * is a compare-and-set on the row's status and status generation, so two
 * coordinators that both rehydrated the run cannot both raise the generation,
 * and one whose view is a generation behind cannot reopen at all. Only a real
 * database serializes the competing UPDATEs. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_reopen_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

/** The fields of an in-memory run the reopen reads and writes. */
interface ReopenView {
  reopenableFailedRow?: boolean;
  statusEpoch?: number;
}

/** Call the tracker's reopen for a rehydrated view of the run. */
function reopen(tracker: ExecutionTracker, view: ReopenView, runId: string): Promise<void> {
  return (
    tracker as unknown as {
      reopenRecoveredRun: (run: ReopenView, runId: string) => Promise<void>;
    }
  ).reopenRecoveredRun(view, runId);
}

describeDb('ExecutionTracker failed-run reopen against a real database', () => {
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
      await terminateTestDbBackends(adminPool, TEST_DB);
      await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
  }, 60_000);

  /** A run whose job reached an agent, failed prematurely: row `failed`, generation 0. */
  async function prematurelyFailedRun(): Promise<{ runId: string; jobId: string }> {
    const tracker = new ExecutionTracker({ db });
    const runId = randomUUID();
    const jobId = randomUUID();
    await tracker.onExecutionStarted(
      runId,
      'build',
      'github',
      'acme/app',
      'main',
      'headsha',
      null,
      {},
      null,
      [{ jobId, jobName: 'test' }],
      'github:1',
    );
    await tracker.onJobStatus(runId, jobId, ExecutionJobStatus.enum.running, Date.now());
    await tracker.failRun(runId, 'No agents available to dispatch jobs');
    expect(await runRow(runId)).toMatchObject({
      status: ExecutionRunStatus.enum.failed,
      status_epoch: 0,
    });
    return { runId, jobId };
  }

  function failureOf(runId: string) {
    return db
      .selectFrom('execution_runs')
      .select(['status', 'failure_reason', 'failure_class'])
      .where('run_id', '=', runId)
      .executeTakeFirstOrThrow();
  }

  function runRow(runId: string) {
    return db
      .selectFrom('execution_runs')
      .select(['status', 'status_epoch', 'completed_at'])
      .where('run_id', '=', runId)
      .executeTakeFirstOrThrow();
  }

  it('reopens on a live job report reaching a fresh coordinator', async () => {
    const { runId, jobId } = await prematurelyFailedRun();
    const coordinator = new ExecutionTracker({ db });

    await coordinator.onJobStatus(runId, jobId, ExecutionJobStatus.enum.success, Date.now());

    // breaks-if-wrong: the rehydrating coordinator reopens the run and raises
    // its generation; completion then settles it again at that generation.
    expect(await runRow(runId)).toMatchObject({
      status: ExecutionRunStatus.enum.success,
      status_epoch: 1,
    });
  });

  it('lets only one of two coordinators reopen the same generation', async () => {
    const { runId } = await prematurelyFailedRun();
    const first: ReopenView = { reopenableFailedRow: true, statusEpoch: 0 };
    const second: ReopenView = { reopenableFailedRow: true, statusEpoch: 0 };
    const lost = vi.spyOn(
      ExecutionTracker.prototype as unknown as { adoptStoredStatusEpoch: () => Promise<void> },
      'adoptStoredStatusEpoch',
    );

    await Promise.all([
      reopen(new ExecutionTracker({ db }), first, runId),
      reopen(new ExecutionTracker({ db }), second, runId),
    ]);

    // fails-when: the reopen UPDATE loses both its `status = failed` and its generation
    // guard, so both apply and each coordinator believes it owns the reopen. Either guard
    // alone stops the second UPDATE here; the test below pins the generation guard.
    expect(await runRow(runId)).toMatchObject({
      status: ExecutionRunStatus.enum.running,
      status_epoch: 1,
    });
    expect(lost).toHaveBeenCalledTimes(1);
    lost.mockRestore();
    // fails-when: the losing coordinator keeps generation 0, so every frame it sends for the
    // reopened run is older than the row and the Platform keeps none of them
    expect([first.statusEpoch, second.statusEpoch]).toEqual([1, 1]);
  });

  it('clears the failure the reopened run recorded', async () => {
    const { runId } = await prematurelyFailedRun();
    // Control: the premature failure is really recorded on the row.
    expect((await failureOf(runId)).failure_reason).toBe('No agents available to dispatch jobs');

    await reopen(
      new ExecutionTracker({ db }),
      { reopenableFailedRow: true, statusEpoch: 0 },
      runId,
    );

    // fails-when: the reopened run keeps the failure it left while it runs, and the Platform
    // mirror carries it into the later success
    expect(await failureOf(runId)).toEqual({
      status: ExecutionRunStatus.enum.running,
      failure_reason: null,
      failure_class: null,
    });
  });

  it('keeps the failure of a run it does not reopen', async () => {
    const { runId } = await prematurelyFailedRun();
    await sql`UPDATE execution_runs SET failure_reason = 'Build job failed' WHERE run_id = ${runId}`.execute(
      db,
    );

    await reopen(
      new ExecutionTracker({ db }),
      { reopenableFailedRow: true, statusEpoch: 0 },
      runId,
    );

    // breaks-if-wrong: the build-failure guard still reads the reason the reopen would clear
    expect(await failureOf(runId)).toMatchObject({
      status: ExecutionRunStatus.enum.failed,
      failure_reason: 'Build job failed',
    });
  });

  it('refuses a reopen from a coordinator whose view is a generation behind', async () => {
    const { runId } = await prematurelyFailedRun();
    // Coordinator B rehydrated the run at generation 0 but has not reopened yet.
    const staleView: ReopenView = { reopenableFailedRow: true, statusEpoch: 0 };
    // Coordinator A reopens it (generation 1), and the run fails prematurely again.
    await reopen(
      new ExecutionTracker({ db }),
      { reopenableFailedRow: true, statusEpoch: 0 },
      runId,
    );
    await sql`UPDATE execution_runs SET status = 'failed', completed_at = now() WHERE run_id = ${runId}`.execute(
      db,
    );

    await reopen(new ExecutionTracker({ db }), staleView, runId);

    // fails-when: the stale view reopens the run at the generation it already
    // has, so the Platform cannot tell this reopen's frames from the last one's.
    expect(await runRow(runId)).toMatchObject({
      status: ExecutionRunStatus.enum.failed,
      status_epoch: 1,
    });
    // The refused view adopts the row's generation, so its later frames are current.
    expect(staleView.statusEpoch).toBe(1);

    // breaks-if-wrong: a view at the current generation still reopens it.
    const current: ReopenView = { reopenableFailedRow: true, statusEpoch: 1 };
    await reopen(new ExecutionTracker({ db }), current, runId);
    expect(await runRow(runId)).toMatchObject({
      status: ExecutionRunStatus.enum.running,
      status_epoch: 2,
    });
    expect(current.statusEpoch).toBe(2);
  });
});
