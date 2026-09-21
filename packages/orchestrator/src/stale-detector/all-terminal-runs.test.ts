import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ExecutionJobStatus, ExecutionRunStatus } from '@kici-dev/engine';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import pg from 'pg';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { selectAllTerminalRunCandidates } from './all-terminal-runs.js';
import { terminateTestDbBackends } from '../__test-helpers__/test-db.js';

/**
 * Real-Postgres tests for the all-terminal run sweep's predicates: they are
 * raw SQL over three tables (`NOT EXISTS`, a `MAX(completed_at)` age check, a
 * `cluster_instances` liveness read), so a mock would record them without
 * evaluating them.
 *
 * Gated on KICI_TEST_ADMIN_DATABASE_URL; the shared vitest globalSetup
 * (scripts/db-test-postgres.ts) supplies it by starting a throwaway container.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_all_terminal_runs_test_${process.pid}_${Date.now()}`;

const MINUTE = 60_000;
const GRACE_MS = 2 * MINUTE;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('selectAllTerminalRunCandidates (real Postgres)', () => {
  let pool: pg.Pool;
  let db: Kysely<Database>;
  const adminUrl = ADMIN_URL!;
  let seq = 0;

  const opts = () => ({
    threshold: new Date(Date.now() - 2 * MINUTE),
    timeBound: new Date(Date.now() - 24 * 60 * MINUTE),
    livenessGraceMs: GRACE_MS,
  });

  const newRunId = (): string => {
    seq += 1;
    return `44444444-4444-4444-8444-${String(seq).padStart(12, '0')}`;
  };

  const insertRun = async (
    runId: string,
    o: { status?: string; holder?: string | null; startedMinutesAgo?: number } = {},
  ): Promise<void> => {
    const started = new Date(Date.now() - (o.startedMinutesAgo ?? 10) * MINUTE);
    await sql`
      INSERT INTO public.execution_runs
        (run_id, workflow_name, provider, repo_identifier, ref, sha, status, started_at,
         registration_window_instance_id)
      VALUES (${runId}::uuid, 'ci', 'github', 'owner/repo', 'main', 'abc',
              ${o.status ?? ExecutionRunStatus.enum.running}, ${started}, ${o.holder ?? null})
    `.execute(db);
  };

  const insertJob = async (
    runId: string,
    jobId: string,
    status: string,
    completedMinutesAgo: number | null,
  ): Promise<void> => {
    const completed =
      completedMinutesAgo === null ? null : new Date(Date.now() - completedMinutesAgo * MINUTE);
    await sql`
      INSERT INTO public.execution_jobs (run_id, job_id, job_name, status, completed_at)
      VALUES (${runId}::uuid, ${jobId}, ${jobId}, ${status}, ${completed})
    `.execute(db);
  };

  const heartbeat = async (instanceId: string, minutesAgo: number): Promise<void> => {
    const at = new Date(Date.now() - minutesAgo * MINUTE);
    await sql`
      INSERT INTO public.cluster_instances (instance_id, last_heartbeat_at)
      VALUES (${instanceId}, ${at})
      ON CONFLICT (instance_id) DO UPDATE SET last_heartbeat_at = EXCLUDED.last_heartbeat_at
    `.execute(db);
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
    await sql`DELETE FROM execution_jobs`.execute(db);
    await sql`DELETE FROM execution_runs`.execute(db);
    await sql`DELETE FROM cluster_instances`.execute(db);
  });

  it('selects a running run whose every job finished past the threshold', async () => {
    const runId = newRunId();
    await insertRun(runId);
    await insertJob(runId, 'build', ExecutionJobStatus.enum.success, 5);
    await insertJob(runId, 'check', ExecutionJobStatus.enum.failed, 4);
    // fails-when: the sweep never matches — a run whose finalizer died stays
    // `running` forever.
    expect(await selectAllTerminalRunCandidates(db, opts())).toEqual([runId]);
  });

  it('spares a run with a job still running', async () => {
    const runId = newRunId();
    await insertRun(runId);
    await insertJob(runId, 'build', ExecutionJobStatus.enum.success, 5);
    await insertJob(runId, 'check', ExecutionJobStatus.enum.running, null);
    // breaks-if-wrong: a healthy run mid-flight must never be finished early.
    expect(await selectAllTerminalRunCandidates(db, opts())).toEqual([]);
  });

  it('spares a run whose last job finished inside the threshold', async () => {
    // The normal completion is in flight; racing it buys nothing.
    const runId = newRunId();
    await insertRun(runId);
    await insertJob(runId, 'build', ExecutionJobStatus.enum.success, 5);
    await insertJob(runId, 'check', ExecutionJobStatus.enum.success, 0.5);
    expect(await selectAllTerminalRunCandidates(db, opts())).toEqual([]);
  });

  it('spares a run with no job rows at all', async () => {
    // A run registered ahead of its dispatch loop; other paths own that shape.
    const runId = newRunId();
    await insertRun(runId);
    expect(await selectAllTerminalRunCandidates(db, opts())).toEqual([]);
  });

  it('spares a run whose registration window holder is alive', async () => {
    const runId = newRunId();
    await insertRun(runId, { holder: 'coord-b' });
    await insertJob(runId, 'build', ExecutionJobStatus.enum.success, 5);
    await heartbeat('coord-b', 0.5);
    // breaks-if-wrong: the owner is still registering its post-build jobs;
    // finishing the run on the build alone is the false-green this exists
    // to stop.
    expect(await selectAllTerminalRunCandidates(db, opts())).toEqual([]);
  });

  it('selects a run whose registration window holder is dead', async () => {
    const runId = newRunId();
    await insertRun(runId, { holder: 'coord-b' });
    await insertJob(runId, 'build', ExecutionJobStatus.enum.success, 5);
    await heartbeat('coord-b', 30);
    // fails-when: a stale holder id keeps the run open forever.
    expect(await selectAllTerminalRunCandidates(db, opts())).toEqual([runId]);
  });

  it('selects a run whose holder never wrote a heartbeat row', async () => {
    const runId = newRunId();
    await insertRun(runId, { holder: 'coord-gone' });
    await insertJob(runId, 'build', ExecutionJobStatus.enum.success, 5);
    expect(await selectAllTerminalRunCandidates(db, opts())).toEqual([runId]);
  });

  it('ignores runs that are already terminal or older than the time bound', async () => {
    const done = newRunId();
    await insertRun(done, { status: ExecutionRunStatus.enum.success });
    await insertJob(done, 'build', ExecutionJobStatus.enum.success, 5);
    const ancient = newRunId();
    await insertRun(ancient, { startedMinutesAgo: 48 * 60 });
    await insertJob(ancient, 'build', ExecutionJobStatus.enum.success, 47 * 60);
    expect(await selectAllTerminalRunCandidates(db, opts())).toEqual([]);
  });
});
