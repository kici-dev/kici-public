/**
 * Real-Postgres coverage for a dropped generated job: its record on the run is
 * what the needs gate and the run's completion read, so only the real tracker
 * and the real `execution_jobs` / `execution_job_needs` tables show whether a
 * dependent is skipped and whether the run fails. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import { ExecutionJobStatus, ExecutionRunStatus, InitFailureCategory } from '@kici-dev/engine';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { ExecutionTracker } from '../reporting/execution-tracker.js';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';
import {
  dispatchMatchedWorkflow,
  type WorkflowDispatchContext,
} from './dispatch-matched-workflow.js';
import {
  makeSingleJobContext,
  TEST_INBOUND_PROVIDER,
} from './dispatch-matched-workflow.test-helpers.js';

/** A runs-on value the host roster lookup fails for, so the job's config cannot be built. */
const BROKEN_HOST = 'broken-host';

const bundle = {
  normalizer: { provider: TEST_INBOUND_PROVIDER },
  repoUrlBuilder: { buildCloneUrl: (repo: string) => `https://git.example/${repo}.git` },
} as unknown as WorkflowDispatchContext['bundle'];

/** A generated job named `name` routed to `runsOn`, needing `needs`. */
function generatedJob(name: string, runsOn: string, needs: string[] = []) {
  return {
    name,
    runsOn: [{ kind: 'exact', value: runsOn }],
    steps: [{ name: 'echo', run: `echo ${name}` }],
    needs,
  };
}

describeWithTestDb<Database>(
  'dispatchMatchedWorkflow — a dropped generated job, against a real database',
  { prefix: 'kici_generated_drop', provider: createMigrationProvider() },
  (getDb) => {
    let db: Kysely<Database>;
    beforeAll(() => {
      ({ db } = getDb());
    });

    /**
     * Dispatch the fixture workflow (a static `build` job plus one dynamic entry
     * generating `generatedJobs`), wait for the dynamic entry to settle, then
     * report the static job and the eval job as agents would.
     */
    async function dispatchAndFinish(generatedJobs: unknown[]): Promise<string> {
      const tracker = new ExecutionTracker({ db });
      const hold = vi.spyOn(tracker, 'holdRunForPendingJobs');
      const release = vi.spyOn(tracker, 'releasePendingJobsHold');
      const { ctx, dispatched } = makeSingleJobContext({
        bundle,
        fullRepo: true,
        withDynamicEntry: true,
        db,
        executionTracker: tracker,
        pendingDynamics: {
          track: vi.fn(async () => generatedJobs),
          resolve: vi.fn(),
          reject: vi.fn(),
          has: vi.fn().mockReturnValue(false),
          cleanup: vi.fn(),
        },
      });
      ctx.runId = randomUUID();
      (ctx.deps as unknown as Record<string, unknown>).hostRosterStore = {
        get: async (id: string) => {
          if (id === BROKEN_HOST) throw new Error('host roster unavailable');
          return null;
        },
      };

      await dispatchMatchedWorkflow(ctx);
      await vi.waitFor(() => {
        expect(hold).toHaveBeenCalled();
        expect(release).toHaveBeenCalledTimes(hold.mock.calls.length);
      });

      // The agents report the static job and the dynamic eval job finished.
      const dispatchedIds = await db
        .selectFrom('execution_jobs')
        .select(['job_id', 'job_name'])
        .where('run_id', '=', ctx.runId)
        .execute();
      for (const d of dispatched) {
        const row = dispatchedIds.find((r) => r.job_name === d.jobName);
        if (!row) continue;
        await tracker.onJobStatus(
          ctx.runId,
          row.job_id,
          ExecutionJobStatus.enum.success,
          Date.now(),
        );
      }
      return ctx.runId;
    }

    function jobRows(runId: string) {
      return db
        .selectFrom('execution_jobs')
        .select(['job_name', 'status', 'error_message', 'init_failure'])
        .where('run_id', '=', runId)
        .execute();
    }

    function runStatus(runId: string) {
      return db
        .selectFrom('execution_runs')
        .select('status')
        .where('run_id', '=', runId)
        .executeTakeFirstOrThrow();
    }

    it('skips a job that needs the dropped one, and fails the run', async () => {
      const runId = await dispatchAndFinish([
        generatedJob('first', BROKEN_HOST),
        generatedJob('second', 'default', ['first']),
      ]);

      const rows = await jobRows(runId);
      const first = rows.find((r) => r.job_name === 'first');
      expect(first?.status).toBe(ExecutionJobStatus.enum.failed);
      expect(first?.init_failure).toMatchObject({
        scope: 'job',
        category: InitFailureCategory.enum.dynamic_eval,
        jobName: 'first',
        message: expect.stringContaining('host roster unavailable'),
      });
      // fails-when: the dropped job is only logged, so `second` waits on an upstream that has no
      // row and stays pending, and the run never completes
      expect(rows.find((r) => r.job_name === 'second')).toMatchObject({
        status: ExecutionJobStatus.enum.skipped,
        error_message: expect.stringContaining('upstream_unmet: first'),
      });
      expect((await runStatus(runId)).status).toBe(ExecutionRunStatus.enum.failed);
    });

    it('fails a run whose dropped job has no dependents', async () => {
      const runId = await dispatchAndFinish([generatedJob('first', BROKEN_HOST)]);

      // fails-when: the dropped job leaves no row, so every job the run holds succeeded and
      // the run finishes green without it
      expect((await runStatus(runId)).status).toBe(ExecutionRunStatus.enum.failed);
    });

    it('succeeds the same run when its generated job resolves', async () => {
      // Positive control for the case above: the same shape with a routable job.
      const runId = await dispatchAndFinish([generatedJob('first', 'default')]);

      // breaks-if-wrong: a generated job that resolves is dispatched and recorded no failure,
      // so the run's failure above comes from the drop alone
      const rows = await jobRows(runId);
      expect(rows.filter((r) => r.status === ExecutionJobStatus.enum.failed)).toEqual([]);
      expect((await runStatus(runId)).status).toBe(ExecutionRunStatus.enum.success);
    });
  },
);
