import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
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

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_invokegate_detail_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

/**
 * Build a gate + proxy + downstream run whose summoned run's job carries the
 * given outputs cell, drive the invoke-gate mirror, and return the ids needed to
 * exercise the dashboard run-detail handler.
 *
 * `summonedJobOutputs` mirrors what the summoned run's job wrote:
 * - a flat `{ <key>: value }` object — the invoke-gate outputs-crossing case,
 *   which the mirror copies onto the proxy job's `outputs` cell;
 * - `null` — the no-output subscriber case (the summoned run's job returns
 *   nothing), where the mirror leaves the proxy's `outputs` cell null.
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
    workflow: 'stg-repo-tests-sub',
  };
  const proxyName = proxyJobName('repo-tests', summonedRun as any);

  await tracker.onExecutionStarted(
    gateRunId,
    'ci',
    'github',
    'acme/parent',
    'refs/heads/master',
    'deadbeef',
    null,
    {},
    null,
    [{ jobId: compileJobId, jobName: '__build__ci' }],
    undefined,
  );

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

  // Summoned run (terminal, with a real span) + a job whose outputs cell is
  // whatever the caller asked for.
  const summonedStart = new Date('2026-08-20T00:00:00.000Z');
  const summonedEnd = new Date('2026-08-20T00:00:45.000Z');
  await db
    .insertInto('execution_runs')
    .values({
      run_id: summonedRunId,
      routing_key: null,
      workflow_name: 'stg-repo-tests-sub',
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
      // A summoned run's outputs are canonically FLAT (InvokeResult.outputs =
      // z.record(z.string(), z.unknown())): a declared run output maps a name
      // straight to a scalar value. A subscriber whose job returns nothing
      // leaves this cell null, and the mirror writes no outputs onto the proxy.
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

describeDb('handleRunDetail — invoke-gate run', () => {
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
      await adminPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [TEST_DB],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
  }, 60_000);

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

    // The handler validates its own response against the wire schema before
    // sending; a validation failure surfaces as an `error` field with empty
    // `jobs`. Regression: a proxy carries the summoned run's FLAT outputs
    // (`{ coverage: '92' }`), which the previous step-keyed `outputs` schema
    // rejected — failing the whole response and degrading the dashboard
    // run-detail page (steps dropped on the Platform DB fallback).
    expect(response.error).toBeUndefined();
    expect(response.jobs).toHaveLength(4);

    // The full response must independently validate against the API schema.
    const parsed = dashboardRunDetailApiResponseSchema.safeParse({ jobs: response.jobs });
    expect(
      parsed.success,
      parsed.success ? '' : JSON.stringify(parsed.error!.issues, null, 2),
    ).toBe(true);

    // The proxy job carries the summoned run's flat outputs verbatim.
    const proxy = response.jobs.find((j: { jobKind?: string }) => j.jobKind === JobKind.Proxy) as {
      outputs: unknown;
    };
    expect(proxy.outputs).toEqual({ coverage: '92' });
  });

  it('produces a schema-valid run-detail response for a proxy with NO outputs', async () => {
    const tracker = new ExecutionTracker({ db });
    // The staging subscriber fixture's `unit` job returns nothing, so the
    // summoned run has no non-secret outputs and the mirror writes none onto the
    // proxy — the proxy's `outputs` cell stays null. This is the exact shape of
    // the run the invoke-gate global-workflow-stg E2E produces.
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

    // A no-output gate run must ALSO produce a schema-valid response: the proxy's
    // null outputs, its mirrored timeline span, and its `jobKind` / `summonedRunId`
    // projection are all valid on their own — nothing here 500s.
    expect(response.error).toBeUndefined();
    expect(response.jobs).toHaveLength(4);

    const parsed = dashboardRunDetailApiResponseSchema.safeParse({ jobs: response.jobs });
    expect(
      parsed.success,
      parsed.success ? '' : JSON.stringify(parsed.error!.issues, null, 2),
    ).toBe(true);

    // The proxy job has no outputs, but still carries its mirrored span and
    // summoned-run linkage.
    const proxy = response.jobs.find((j: { jobKind?: string }) => j.jobKind === JobKind.Proxy) as {
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
});
