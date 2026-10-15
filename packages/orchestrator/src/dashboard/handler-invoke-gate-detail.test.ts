import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, expect, it } from 'vitest';
import { type Kysely, sql } from 'kysely';
import {
  ExecutionRunStatus,
  ExecutionJobStatus,
  dashboardRunDetailApiResponseSchema,
} from '@kici-dev/engine';
import { createMigrationProvider } from '../db/migration-provider.js';
import { JobKind } from '../db/types.js';
import type { Database } from '../db/types.js';
import { ExecutionTracker } from '../reporting/execution-tracker.js';
import { DashboardHandler } from './handler.js';
import { proxyJobName } from '../pipeline/invoke-gate.js';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';
import { startRun } from '../__test-helpers__/tracker.js';

/**
 * Build a gate + proxy + downstream run and drive the invoke-gate mirror.
 * `summonedJobOutputs` is the summoned job's outputs cell: a flat
 * `{ <key>: value }` object, which the mirror copies onto the proxy job, or
 * `null` (a no-output subscriber), which leaves the proxy's cell null.
 */
async function buildGateRun(
  tracker: ExecutionTracker,
  db: Kysely<Database>,
  summonedJobOutputs: Record<string, unknown> | null,
): Promise<{ gateRunId: string; proxyName: string }> {
  const gateRunId = randomUUID();
  const summonedRunId = randomUUID();
  const compileJobId = randomUUID();
  const gateJobId = randomUUID();
  const proxyJobId = randomUUID();
  const globalLogJobId = randomUUID();

  const summonedRun = {
    runId: summonedRunId,
    repo: 'acme/canary',
    workflow: 'repo-tests-sub',
  };
  const proxyName = proxyJobName('repo-tests', summonedRun as any);

  await startRun(tracker, {
    runId: gateRunId,
    repoIdentifier: 'acme/parent',
    ref: 'refs/heads/master',
    sha: 'deadbeef',
    deliveryId: null,
    jobs: [{ jobId: compileJobId, jobName: '__build__ci' }],
  });

  await tracker.addJobsToRun(gateRunId, [
    { jobId: gateJobId, jobName: 'repo-tests', jobKind: JobKind.Gate, contexts: ['stg'] } as any,
    {
      jobId: proxyJobId,
      jobName: proxyName,
      baseJobName: 'repo-tests',
      variantKind: 'invoke',
      variantLabel: `${summonedRun.repo}:${summonedRun.workflow}`,
      jobKind: JobKind.Proxy,
      summonedRunId,
    },
    { jobId: globalLogJobId, jobName: 'global-log' },
  ]);
  await db
    .insertInto('execution_job_needs')
    .values({
      run_id: gateRunId,
      job_name: 'global-log',
      upstream_name: 'repo-tests',
      run_on: JSON.stringify(['success']),
    } as any)
    .execute();

  // A terminal summoned run with a real span.
  const summonedStart = new Date('2026-08-20T00:00:00.000Z');
  const summonedEnd = new Date('2026-08-20T00:00:45.000Z');
  await db
    .insertInto('execution_runs')
    .values({
      run_id: summonedRunId,
      routing_key: null,
      workflow_name: 'repo-tests-sub',
      status: ExecutionRunStatus.enum.success,
      provider: 'github',
      repo_identifier: 'acme/canary',
      ref: 'refs/heads/master',
      sha: 'cafef00d',
      started_at: summonedStart,
      completed_at: summonedEnd,
      summoned_by_run_id: gateRunId,
      summoned_by_proxy_job: proxyName,
    })
    .execute();
  await db
    .insertInto('execution_jobs')
    .values({
      run_id: summonedRunId,
      job_id: randomUUID(),
      routing_key: null,
      job_name: 'unit',
      status: ExecutionJobStatus.enum.success,
      // Canonically FLAT (InvokeResult.outputs = z.record(z.string(), z.unknown())):
      // a declared run output maps a name straight to a scalar value.
      outputs: summonedJobOutputs === null ? null : JSON.stringify(summonedJobOutputs),
    })
    .execute();

  await tracker.reconcileSummonedRunIfTerminal(summonedRunId);
  await tracker.onJobStatus(gateRunId, gateJobId, ExecutionJobStatus.enum.success, Date.now());
  await tracker.onJobStatus(gateRunId, globalLogJobId, ExecutionJobStatus.enum.success, Date.now());

  return { gateRunId, proxyName };
}

function makeHandler(db: Kysely<Database>, sent: unknown[]): DashboardHandler {
  return new DashboardHandler({
    db,
    logStorage: {
      append: async () => {},
      read: async () => ({ data: '', cursor: 0, complete: true }),
      exists: async () => false,
      list: async () => [],
    } as any,
    send: (m: unknown) => sent.push(m),
    onRerun: async () => ({ newRunId: '' }),
    onCancel: async () => ({ cancelledJobs: 0 }),
    onManualSchedule: async () => ({ newRunId: '' }),
  });
}

describeWithTestDb<Database>(
  'handleRunDetail — invoke-gate run',
  { prefix: 'kici_invokegate_detail', provider: createMigrationProvider() },
  (getDb) => {
    let db: Kysely<Database>;

    beforeAll(() => {
      ({ db } = getDb());
    });

    beforeEach(async () => {
      await sql`DELETE FROM execution_job_needs`.execute(db);
      await sql`DELETE FROM execution_steps`.execute(db);
      await sql`DELETE FROM execution_jobs`.execute(db);
      await sql`DELETE FROM execution_runs`.execute(db);
    });

    it('produces a schema-valid run-detail response for a proxy carrying flat outputs', async () => {
      const tracker = new ExecutionTracker({ db });
      const { gateRunId } = await buildGateRun(tracker, db, { coverage: '92' });

      const sent: any[] = [];
      const handler = makeHandler(db, sent);
      await handler.handleRunDetail({
        type: 'dashboard.run.detail',
        requestId: 'req-1',
        runId: gateRunId,
      } as any);

      expect(sent).toHaveLength(1);
      const response = sent[0];

      // The handler schema-validates its response; a failure surfaces as `error`
      // with empty `jobs`. A proxy's FLAT outputs (`{ coverage: '92' }`) must pass;
      // a step-keyed `outputs` schema rejects them and degrades run detail
      // (steps dropped on the Platform DB fallback).
      expect(response.error).toBeUndefined();
      expect(response.jobs).toHaveLength(4);

      const parsed = dashboardRunDetailApiResponseSchema.safeParse({ jobs: response.jobs });
      expect(
        parsed.success,
        parsed.success ? '' : JSON.stringify(parsed.error!.issues, null, 2),
      ).toBe(true);

      // The proxy job carries the summoned run's flat outputs verbatim.
      const proxy = response.jobs.find(
        (j: { jobKind?: string }) => j.jobKind === JobKind.Proxy,
      ) as {
        outputs: unknown;
      };
      expect(proxy.outputs).toEqual({ coverage: '92' });
    });

    it('produces a schema-valid run-detail response for a proxy with NO outputs', async () => {
      const tracker = new ExecutionTracker({ db });
      // A subscriber that declares no outputs: the proxy's `outputs` cell stays null.
      const { gateRunId } = await buildGateRun(tracker, db, null);

      const sent: any[] = [];
      const handler = makeHandler(db, sent);
      await handler.handleRunDetail({
        type: 'dashboard.run.detail',
        requestId: 'req-1',
        runId: gateRunId,
      } as any);

      expect(sent).toHaveLength(1);
      const response = sent[0];

      expect(response.error).toBeUndefined();
      expect(response.jobs).toHaveLength(4);

      const parsed = dashboardRunDetailApiResponseSchema.safeParse({ jobs: response.jobs });
      expect(
        parsed.success,
        parsed.success ? '' : JSON.stringify(parsed.error!.issues, null, 2),
      ).toBe(true);

      // No outputs, but the mirrored span and summoned-run linkage remain.
      const proxy = response.jobs.find(
        (j: { jobKind?: string }) => j.jobKind === JobKind.Proxy,
      ) as {
        outputs: unknown;
        summonedRunId: string | null;
        startedAt: number | null;
        completedAt: number | null;
        durationMs: number | null;
      };
      expect(proxy.outputs).toBeNull();
      expect(proxy.summonedRunId).not.toBeNull();
      // The mirror copied the summoned run's own 45s span onto the proxy.
      expect(proxy.startedAt).not.toBeNull();
      expect(proxy.completedAt).not.toBeNull();
      expect(proxy.durationMs).toBe(45_000);
    });
  },
);
