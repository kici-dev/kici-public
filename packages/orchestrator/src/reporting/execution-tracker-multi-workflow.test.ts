import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { ExecutionJobStatus } from '@kici-dev/engine';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { ExecutionTracker } from './execution-tracker.js';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';
import { startRun } from '../__test-helpers__/tracker.js';

/**
 * Real-Postgres coverage of a run that spans several workflows: a `kici run`
 * fixture run with no `--workflow` dispatches every matched workflow under one
 * run id, so each `onExecutionStarted` call meets the run the previous one
 * registered. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
describeWithTestDb<Database>(
  'ExecutionTracker run spanning several workflows',
  { prefix: 'kici_multi_workflow', provider: createMigrationProvider() },
  (getDb) => {
    let db: Kysely<Database>;

    beforeAll(() => {
      ({ db } = getDb());
    });

    async function startTwoWorkflows(tracker: ExecutionTracker, runId: string): Promise<void> {
      await startRun(tracker, {
        runId,
        workflowName: 'hello-world',
        jobs: [{ jobId: 'job-hello', jobName: 'hello' }],
      });
      // The same job name in a second workflow: only the workflow tells them apart.
      await startRun(tracker, {
        runId,
        workflowName: 'repro-406',
        jobs: [
          { jobId: 'job-init-fails', jobName: 'init-fails' },
          { jobId: 'job-hello-2', jobName: 'hello' },
        ],
      });
    }

    it('records each job with the workflow that defines it', async () => {
      const tracker = new ExecutionTracker({ db });
      const runId = randomUUID();
      await startTwoWorkflows(tracker, runId);

      const rows = await db
        .selectFrom('execution_jobs')
        .select(['job_id', 'workflow_name'])
        .where('run_id', '=', runId)
        .orderBy('job_id')
        .execute();
      // fails-when: a job row carries no workflow, or the run's first workflow for every job
      expect(rows).toEqual([
        { job_id: 'job-hello', workflow_name: 'hello-world' },
        { job_id: 'job-hello-2', workflow_name: 'repro-406' },
        { job_id: 'job-init-fails', workflow_name: 'repro-406' },
      ]);
    });

    it('keeps the earlier workflow jobs tracked when a later workflow registers', async () => {
      const tracker = new ExecutionTracker({ db });
      const runId = randomUUID();
      await startTwoWorkflows(tracker, runId);

      for (const jobId of ['job-init-fails', 'job-hello-2']) {
        await tracker.onJobStatus(runId, jobId, ExecutionJobStatus.enum.success, Date.now());
      }
      // fails-when: the second registration replaces the run state and drops `job-hello`,
      // so the run completes while a job of the first workflow is still pending
      expect(tracker.isRunComplete(runId)).toBe(false);

      await tracker.onJobStatus(runId, 'job-hello', ExecutionJobStatus.enum.success, Date.now());
      // breaks-if-wrong: the run must still complete once every job of every workflow is terminal
      expect(tracker.isRunComplete(runId)).toBe(true);
    });

    it('names each failed job with its workflow in the failure summary', async () => {
      const tracker = new ExecutionTracker({ db });
      const runId = randomUUID();
      await startTwoWorkflows(tracker, runId);
      const now = Date.now();
      await tracker.onJobStatus(runId, 'job-hello', ExecutionJobStatus.enum.failed, now);
      await tracker.onJobStatus(runId, 'job-init-fails', ExecutionJobStatus.enum.failed, now);
      await tracker.onJobStatus(runId, 'job-hello-2', ExecutionJobStatus.enum.success, now);

      const run = await db
        .selectFrom('execution_runs')
        .select(['status', 'failure_reason'])
        .where('run_id', '=', runId)
        .executeTakeFirstOrThrow();
      // fails-when: the summary lists bare job names, so `hello` reads as the first workflow's job
      expect(run).toEqual({
        status: 'failed',
        failure_reason: 'Failed jobs: hello-world / hello, repro-406 / init-fails',
      });
    });

    it('keeps bare job names in the failure summary of a single-workflow run', async () => {
      const tracker = new ExecutionTracker({ db });
      const runId = randomUUID();
      await startRun(tracker, {
        runId,
        workflowName: 'ci',
        jobs: [{ jobId: 'job-build', jobName: 'build' }],
      });
      await tracker.onJobStatus(runId, 'job-build', ExecutionJobStatus.enum.failed, Date.now());
      const run = await db
        .selectFrom('execution_runs')
        .select('failure_reason')
        .where('run_id', '=', runId)
        .executeTakeFirstOrThrow();
      // breaks-if-wrong: a run of one workflow keeps the summary every existing reader expects
      expect(run.failure_reason).toBe('Failed jobs: build');
    });

    it('records the workflow on a job row a rerouted job status creates', async () => {
      const tracker = new ExecutionTracker({ db });
      const runId = randomUUID();
      await startRun(tracker, { runId, workflowName: 'hello-world', jobs: [] });
      // A worker-rerouted job is known by name only until its first status.
      tracker.registerJobName(runId, 'job-rerouted', 'build', 'repro-410');
      await tracker.onJobStatus(runId, 'job-rerouted', ExecutionJobStatus.enum.running, Date.now());
      const row = await db
        .selectFrom('execution_jobs')
        .select('workflow_name')
        .where('run_id', '=', runId)
        .where('job_id', '=', 'job-rerouted')
        .executeTakeFirstOrThrow();
      // fails-when: the row a status update creates records no workflow
      expect(row.workflow_name).toBe('repro-410');
    });
  },
);
