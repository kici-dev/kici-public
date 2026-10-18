import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { ExecutionTracker } from '../reporting/execution-tracker.js';
import { RbacEnforcer, type Role } from '../secrets/rbac.js';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';
import { startRun } from '../__test-helpers__/tracker.js';
import { createAdminRunRoutes } from './admin-runs.js';

/**
 * Real-Postgres coverage of the admin run routes for a run that spans several
 * workflows (an older `kici`'s shared fixture run), and for a job row written
 * before `execution_jobs.workflow_name` existed. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
describeWithTestDb<Database>(
  'admin run routes on a run spanning several workflows',
  { prefix: 'kici_admin_runs_multi_wf', provider: createMigrationProvider() },
  (getDb) => {
    let db: Kysely<Database>;
    let app: ReturnType<typeof createAdminRunRoutes>;

    beforeAll(() => {
      ({ db } = getDb());
      app = createAdminRunRoutes({
        db,
        tokenManager: {
          validate: vi.fn().mockResolvedValue({
            id: 'user-1',
            role: 'owner' as Role,
            routingKey: null,
            label: 'test',
          }),
        } as never,
        rbac: new RbacEnforcer(),
        auditLogger: { log: vi.fn() } as never,
      } as never);
    });

    async function get(path: string): Promise<any> {
      const res = await app.request(`http://localhost/api/v1/admin/runs${path}`, {
        headers: { Authorization: 'Bearer token' },
      });
      expect(res.status).toBe(200);
      return res.json();
    }

    async function startFixtureRun(runId: string): Promise<void> {
      const tracker = new ExecutionTracker({ db });
      await startRun(tracker, {
        runId,
        workflowName: 'hello-world',
        jobs: [{ jobId: `${runId}-a`, jobName: 'mise-pinned' }],
      });
      await startRun(tracker, {
        runId,
        workflowName: 'repro-461',
        jobs: [{ jobId: `${runId}-b`, jobName: 'mise-pinned' }],
      });
      await db
        .updateTable('execution_runs')
        .set({ is_test_run: true })
        .where('run_id', '=', runId)
        .execute();
    }

    it('names every workflow on the run and each job with its own', async () => {
      const runId = randomUUID();
      await startFixtureRun(runId);

      const shown = await get(`/${runId}`);
      // breaks-if-wrong: the existing field keeps naming the run's first workflow
      expect(shown.run.workflowName).toBe('hello-world');
      // fails-when: the run names only its first workflow
      expect(shown.run.workflowNames).toEqual(['hello-world', 'repro-461']);

      const { jobs } = await get(`/${runId}/jobs`);
      // fails-when: two same-named jobs from different workflows are indistinguishable
      expect(
        jobs.map((j: { jobId: string; workflowName: string }) => [j.jobId, j.workflowName]),
      ).toEqual([
        [`${runId}-a`, 'hello-world'],
        [`${runId}-b`, 'repro-461'],
      ]);

      const listed = await get(`?workflowName=repro-461`);
      // fails-when: the workflow filter matches only the run's first workflow
      expect(listed.runs.map((r: { runId: string }) => r.runId)).toContain(runId);
      const row = listed.runs.find((r: { runId: string }) => r.runId === runId);
      expect(row.workflowNames).toEqual(['hello-world', 'repro-461']);
    });

    it('reads a job row with no recorded workflow as the run workflow, unless a fixture run', async () => {
      const tracker = new ExecutionTracker({ db });
      const plainRun = randomUUID();
      const fixtureRun = randomUUID();
      for (const runId of [plainRun, fixtureRun]) {
        await startRun(tracker, {
          runId,
          workflowName: 'ci',
          jobs: [{ jobId: `${runId}-old`, jobName: 'build' }],
        });
        // A row written before the column existed.
        await db
          .updateTable('execution_jobs')
          .set({ workflow_name: null })
          .where('run_id', '=', runId)
          .execute();
      }
      await db
        .updateTable('execution_runs')
        .set({ is_test_run: true })
        .where('run_id', '=', fixtureRun)
        .execute();

      // breaks-if-wrong: an upgraded run of one workflow still names it on every job
      expect((await get(`/${plainRun}/jobs`)).jobs[0].workflowName).toBe('ci');
      // fails-when: a legacy fixture-run job is labelled with the run's first workflow
      expect((await get(`/${fixtureRun}/jobs`)).jobs[0].workflowName).toBeNull();
      expect((await get(`/${fixtureRun}`)).run.workflowNames).toEqual(['ci']);
    });

    it('resolves a run id prefix against the UUID column', async () => {
      const runId = randomUUID();
      await startRun(new ExecutionTracker({ db }), {
        runId,
        workflowName: 'ci',
        jobs: [{ jobId: `${runId}-a`, jobName: 'build' }],
      });
      const short = runId.slice(0, 8);
      const listed = await get(`?runIdPrefix=${short}&limit=100`);
      // fails-when: the UUID range does not match the run whose id starts with the prefix
      expect(listed.runs.map((r: { runId: string }) => r.runId)).toContain(runId);
      // breaks-if-wrong: every run listed starts with the prefix
      for (const r of listed.runs as Array<{ runId: string }>)
        expect(r.runId.startsWith(short)).toBe(true);
      // A prefix that crosses the first hyphen narrows the range further.
      const longer = await get(`?runIdPrefix=${runId.slice(0, 13)}`);
      expect(longer.runs.map((r: { runId: string }) => r.runId)).toEqual([runId]);
    });

    it('lists a job image build, then its init steps, then its steps, with their phase', async () => {
      const runId = randomUUID();
      const jobId = `${runId}-a`;
      await startRun(new ExecutionTracker({ db }), {
        runId,
        workflowName: 'ci',
        jobs: [{ jobId, jobName: 'build' }],
      });
      const step = (step_index: number, step_type: string) => ({
        run_id: runId,
        job_id: jobId,
        step_index,
        step_name: step_type === 'step' ? `step-${step_index}` : step_type,
        step_type,
        started_at: null,
        completed_at: null,
        duration_ms: null,
        exit_code: null,
        error_message: null,
        log_path: null,
        secrets_accessed: null,
        check_outcome: null,
        drift_summary: null,
        concurrency_kind: null,
        group_id: null,
        routing_key: null,
        archived_at: null,
        archive_object_key: null,
      });
      await db
        .insertInto('execution_steps')
        .values([
          step(0, 'step'),
          step(1, 'step'),
          step(1_000_001, 'init:1'),
          step(1_000_000, 'init:0'),
          step(2_000_000, 'container:build'),
          // Only looks like an init: the SQL and in-memory rank must both treat it as a step.
          step(5, 'init:x'),
        ])
        .execute();

      const { jobs } = await get(`/${runId}/jobs?includeSteps=true`);
      const steps = jobs[0].steps as Array<Record<string, unknown>>;
      // fails-when: the SQL sort has no init rank, so the init steps come after the steps
      expect(steps.map((s) => s.stepType)).toEqual([
        'container:build',
        'init:0',
        'init:1',
        'step',
        'step',
        'init:x',
      ]);
      // breaks-if-wrong: the stored index reaches the reader unchanged
      expect(steps[1]).toMatchObject({ stepIndex: 1_000_000, phase: 'init', initIndex: 0 });
      // fails-when: the additive fields are missing or set on a non-init step
      expect(steps[0]).toMatchObject({ phase: 'setup' });
      expect(steps[3]).toMatchObject({ stepIndex: 0, phase: 'steps' });
      expect(steps[3]).not.toHaveProperty('initIndex');
      expect(steps[5]).not.toHaveProperty('initIndex');
    });
  },
);
