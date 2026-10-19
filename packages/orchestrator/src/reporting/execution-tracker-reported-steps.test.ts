import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { ExecutionJobStatus, ExecutionStepStatus } from '@kici-dev/engine';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { ExecutionTracker } from './execution-tracker.js';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';
import { startRun } from '../__test-helpers__/tracker.js';

/**
 * Real-Postgres coverage for the step rows of a job that streamed no
 * `step.status`: a job whose rules returned `false` ends before any step
 * starts, and reports every step skipped only in its terminal `job.status`.
 * Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
describeWithTestDb<Database>(
  'ExecutionTracker records the steps a job reported but never streamed',
  { prefix: 'kici_reported_steps', provider: createMigrationProvider() },
  (getDb) => {
    let db: Kysely<Database>;
    beforeAll(() => {
      ({ db } = getDb());
    });

    async function runningJob(): Promise<{
      tracker: ExecutionTracker;
      runId: string;
      jobId: string;
    }> {
      const tracker = new ExecutionTracker({ db });
      const runId = randomUUID();
      const jobId = randomUUID();
      await startRun(tracker, {
        runId,
        workflowName: 'ci',
        repoIdentifier: 'acme/app',
        ref: 'main',
        sha: 'headsha',
        deliveryId: null,
        jobs: [{ jobId, jobName: 'publish' }],
        routingKey: 'github:1',
      });
      await tracker.onJobStatus(runId, jobId, ExecutionJobStatus.enum.running, Date.now());
      return { tracker, runId, jobId };
    }

    function stepRows(runId: string, jobId: string) {
      return db
        .selectFrom('execution_steps')
        .select(['step_index', 'step_name', 'status', 'duration_ms'])
        .where('run_id', '=', runId)
        .where('job_id', '=', jobId)
        .orderBy('step_index')
        .execute();
    }

    it('records each step a rule-skipped job reports as skipped', async () => {
      const { tracker, runId, jobId } = await runningJob();

      await tracker.onJobStatus(runId, jobId, ExecutionJobStatus.enum.skipped, Date.now(), 'a1', {
        error: "rule 'push to main' returned false",
        stepResults: [
          { name: 'build', status: 'skipped', durationMs: 0 },
          { name: 'publish', status: 'skipped', durationMs: 0 },
        ],
      });

      // fails-when: the skipped job keeps no step rows, so `kici runs show`
      // reads it as a job that ran on an agent and reported no steps
      expect(await stepRows(runId, jobId)).toEqual([
        { step_index: 0, step_name: 'build', status: 'skipped', duration_ms: 0 },
        { step_index: 1, step_name: 'publish', status: 'skipped', duration_ms: 0 },
      ]);
    });

    it('keeps the rows of a job that streamed its steps, whatever its stepResults say', async () => {
      const { tracker, runId, jobId } = await runningJob();
      await tracker.onStepStatus(runId, jobId, 0, 'build', ExecutionStepStatus.enum.running, 1);
      await tracker.onStepStatus(runId, jobId, 0, 'build', ExecutionStepStatus.enum.success, 2, {
        durationMs: 40,
      });

      await tracker.onJobStatus(runId, jobId, ExecutionJobStatus.enum.success, Date.now(), 'a1', {
        stepResults: [
          { name: 'build', status: 'success', durationMs: 40 },
          { name: 'hook:afterStep', status: 'success', durationMs: 1 },
        ],
      });

      // breaks-if-wrong: a job that streamed its steps must not gain rows from
      // its summary, whose positions need not match the streamed step indexes
      expect(await stepRows(runId, jobId)).toEqual([
        { step_index: 0, step_name: 'build', status: 'success', duration_ms: 40 },
      ]);
    });

    it('records nothing a job did not report, and no non-terminal entry', async () => {
      const { tracker, runId, jobId } = await runningJob();

      await tracker.onJobStatus(runId, jobId, ExecutionJobStatus.enum.failed, Date.now(), 'a1', {
        error: 'setup failed',
        stepResults: [
          { name: 'build', status: 'running' },
          { status: 'skipped' },
          { name: 'deploy', status: 'skipped', durationMs: 0 },
        ],
      });

      // The kept entry keeps its own position as its index.
      expect(await stepRows(runId, jobId)).toEqual([
        { step_index: 2, step_name: 'deploy', status: 'skipped', duration_ms: 0 },
      ]);
    });

    it('keeps a finished step finished when its running frame lands late', async () => {
      const { tracker, runId, jobId } = await runningJob();
      await tracker.onStepStatus(
        runId,
        jobId,
        1,
        'gated',
        ExecutionStepStatus.enum.skipped,
        2_000,
        {
          durationMs: 0,
        },
      );
      // The step's running frame, applied after its terminal one.
      await tracker.onStepStatus(runId, jobId, 1, 'gated', ExecutionStepStatus.enum.running, 1_000);
      // The job completing reconciles only steps still running.
      await tracker.onJobStatus(runId, jobId, ExecutionJobStatus.enum.success, Date.now(), 'a1');

      // fails-when: the late running frame reverts the row, and the completion
      // reconciles it to the job's success
      const [row] = await db
        .selectFrom('execution_steps')
        .select(['status', 'started_at'])
        .where('run_id', '=', runId)
        .where('job_id', '=', jobId)
        .execute();
      expect(row?.status).toBe('skipped');
      expect(row?.started_at).toEqual(new Date(1_000));
    });

    it('still records a running frame for a step that has not finished', async () => {
      const { tracker, runId, jobId } = await runningJob();
      // breaks-if-wrong: the monotonic write must not refuse an ordinary start
      await tracker.onStepStatus(runId, jobId, 0, 'build', ExecutionStepStatus.enum.running, 1_000);
      expect((await stepRows(runId, jobId))[0]?.status).toBe('running');
      await tracker.onStepStatus(
        runId,
        jobId,
        0,
        'build',
        ExecutionStepStatus.enum.success,
        2_000,
        {
          durationMs: 5,
        },
      );
      expect((await stepRows(runId, jobId))[0]?.status).toBe('success');
    });
  },
);
