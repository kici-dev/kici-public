import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import {
  ApprovalDecision,
  CheckRunConclusion,
  ExecutionJobStatus,
  ExecutionRunStatus,
  HoldScope,
  INSTALL_JOB_ID_PREFIX,
  TriggerSource,
} from '@kici-dev/engine';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database, HeldRun } from '../db/types.js';
import { HeldRunStatus, HeldRunStore } from '../contexts/held-runs.js';
import { ExecutionTracker } from '../reporting/execution-tracker.js';
import { JobQueue } from '../queue/job-queue.js';
import { AgentRegistry } from '../agent/registry.js';
import { buildSecurityHoldData } from '../pipeline/dispatch-matched-workflow.js';
import { ROUND_JOB_PREFIX } from '../pipeline/global-eval-round.js';
import {
  loadPendingWorkflowContext,
  storePendingWorkflowContext,
  type SerializableWorkflowDispatchInputs,
} from '../pipeline/pending-workflow-context.js';
import { rejectWorkflow } from '../pipeline/resume-workflow.js';
import type { ProcessingDeps } from '../pipeline/processor.js';
import { applyDecision } from '../approvals/apply-decision.js';
import {
  cancelRunWithReason,
  RUN_REJECTED_BEFORE_CANCEL_MESSAGE,
  RUN_RESUMING_AFTER_APPROVAL_MESSAGE,
  type CancelRunDeps,
} from './cancel-run.js';
import { cancelRouteAnswer } from './cancel-route-answer.js';
import { HeldRunWithdrawal, type RejectHeldWorkflowOptions } from './cancel-held-run.js';
import { createDashboardCancelHandler } from './dashboard-cancel-handler.js';
import { terminateTestDbBackends } from '../__test-helpers__/test-db.js';

/**
 * Real-Postgres coverage for cancelling a `held` run: the cancel withdraws the
 * approval request through the hold-rejection path, so the hold, the pending
 * security check and the stored dispatch context are settled with the run, and
 * a later approve finds nothing to release. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_cancel_held_run_${process.pid}_${Date.now()}`;

const ORG_ID = 'org-1';
const ROUTING_KEY = 'github:1';
const SOURCE_REPO = 'acme/app';
const WORKFLOW_REPO = 'acme/ci';
const REASON = 'run cancelled by alice';

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('cancelling a held run (real Postgres)', () => {
  let pool: pg.Pool;
  let db: Kysely<Database>;
  const adminUrl = ADMIN_URL!;

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

  /** Everything a cancel reaches, with the provider side replaced by spies. */
  function harness(overrides: Partial<CancelRunDeps> = {}) {
    const tracker = new ExecutionTracker({ db });
    const postCheckStatus = vi.fn(async () => undefined);
    const completeUndispatchedCheckRuns = vi.fn(async () => undefined);
    const procDeps = {
      db,
      executionTracker: tracker,
      checkRunReporter: { completeUndispatchedCheckRuns },
      providerRegistry: { getByRoutingKey: () => ({ checkStatusPoster: { postCheckStatus } }) },
    } as unknown as ProcessingDeps;
    const rejectHeldWorkflow = vi.fn(
      (hold: HeldRun, reason: string, opts?: RejectHeldWorkflowOptions) =>
        rejectWorkflow(hold, procDeps, db, reason, opts),
    );
    const cancelDeps = {
      db,
      jobQueue: new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 }),
      registry: new AgentRegistry(),
      executionTracker: tracker,
      rejectHeldWorkflow,
      ...overrides,
    };
    const cancel = (runId: string) =>
      cancelRunWithReason(cancelDeps, runId, REASON, { cancelledBy: 'alice' });
    const dashboardCancel = createDashboardCancelHandler(cancelDeps);
    return {
      tracker,
      postCheckStatus,
      completeUndispatchedCheckRuns,
      cancel,
      dashboardCancel,
      rejectHeldWorkflow,
    };
  }

  /** A run held by the org trust policy, as `holdRunForSecurityPolicy` writes it. */
  async function holdRun(
    tracker: ExecutionTracker,
    opts: { round: boolean },
  ): Promise<{ runId: string; heldRunId: string }> {
    const runId = randomUUID();
    await tracker.recordRunHeld({
      runId,
      workflowName: opts.round ? `${ROUND_JOB_PREFIX}${WORKFLOW_REPO}` : 'build',
      provider: 'github',
      repoIdentifier: SOURCE_REPO,
      workflowRepoIdentifier: WORKFLOW_REPO,
      ref: 'main',
      sha: `sha-${runId}`,
      deliveryId: null,
      providerContext: { installationId: 1 },
      routingKey: ROUTING_KEY,
      reason: 'fork_pr',
      prNumber: 7,
      ...(opts.round && { isGlobalEvalRound: true }),
    });
    const store = new HeldRunStore(db);
    const hold = await store.create(
      ORG_ID,
      buildSecurityHoldData(runId, {
        action: 'hold',
        reason: 'fork_pr',
        message: 'fork pull request',
        approvalExpirySeconds: null,
      }),
    );
    await store.markPendingCheckPosted(ORG_ID, [hold.id]);
    if (!opts.round) {
      // A per-repository hold stores the dispatch an approve would replay; a
      // held round stores none.
      await storePendingWorkflowContext(db, {
        runId,
        resolvedOrgId: ORG_ID,
        repoIdentifier: SOURCE_REPO,
        ref: `sha-${runId}`,
        info: { provider: 'github', routingKey: ROUTING_KEY },
        workflow: { name: 'build', jobs: [] },
        credentials: { installationId: 1 },
      } as unknown as SerializableWorkflowDispatchInputs);
    }
    return { runId, heldRunId: hold.id };
  }

  async function runStatus(runId: string) {
    const row = await db
      .selectFrom('execution_runs')
      .select(['status', 'cancelled_by'])
      .where('run_id', '=', runId)
      .executeTakeFirstOrThrow();
    return row;
  }

  async function holdStatus(heldRunId: string) {
    const row = await db
      .selectFrom('held_runs')
      .select(['status'])
      .where('id', '=', heldRunId)
      .executeTakeFirstOrThrow();
    return row.status;
  }

  /** Approve the hold through the shared applier, as the dashboard and CLI do. */
  async function approve(heldRunId: string) {
    const onWorkflowRelease = vi.fn(async () => undefined);
    const settleSecurityCheck = vi.fn(async () => true);
    const result = await applyDecision(
      {
        orgId: ORG_ID,
        store: new HeldRunStore(db),
        teamMembershipLookup: () => new Set<string>(),
        allowSelfApproval: true,
        resolveTriggererSub: async () => undefined,
        onJobRelease: vi.fn(async () => undefined),
        onWorkflowRelease,
        settleSecurityCheck,
      },
      { heldRunId, actorSub: 'bob', decision: ApprovalDecision.enum.approve },
    );
    await result.consequence;
    return { result, onWorkflowRelease, settleSecurityCheck };
  }

  it('withdraws a held per-repository run: hold rejected, checks cancelled, context dropped', async () => {
    const { tracker, postCheckStatus, completeUndispatchedCheckRuns, cancel } = harness();
    const { runId, heldRunId } = await holdRun(tracker, { round: false });
    // Control: the context an approve would replay is really stored.
    expect(await loadPendingWorkflowContext(db, runId)).not.toBeNull();

    const result = await cancel(runId);

    expect(result.alreadyTerminal).toBe(false);
    expect(result.decidedBeforeCancel).toBeUndefined();
    expect(cancelRouteAnswer(result)).toMatchObject({
      httpStatus: 200,
      body: { status: ExecutionRunStatus.enum.cancelled },
    });
    // fails-when: the cancel moves only the run row and leaves the hold pending
    expect(await holdStatus(heldRunId)).toBe(HeldRunStatus.Rejected);
    expect(await runStatus(runId)).toEqual({
      status: ExecutionRunStatus.enum.cancelled,
      cancelled_by: 'alice',
    });
    expect(postCheckStatus).toHaveBeenCalledWith(
      SOURCE_REPO,
      `sha-${runId}`,
      CheckRunConclusion.enum.cancelled,
      'Rejected',
      expect.any(String),
      expect.anything(),
    );
    expect(completeUndispatchedCheckRuns).toHaveBeenCalledWith(
      expect.objectContaining({ runId, conclusion: CheckRunConclusion.enum.cancelled }),
    );
    expect(await loadPendingWorkflowContext(db, runId)).toBeNull();

    // A later approve finds nothing to release and posts no success check.
    const { result: decision, onWorkflowRelease, settleSecurityCheck } = await approve(heldRunId);
    expect(decision.status).toBe('not-found');
    expect(onWorkflowRelease).not.toHaveBeenCalled();
    expect(settleSecurityCheck).not.toHaveBeenCalled();
  });

  it('withdraws a held global evaluation round: the round never runs', async () => {
    const { tracker, postCheckStatus, cancel } = harness();
    const { runId, heldRunId } = await holdRun(tracker, { round: true });

    await cancel(runId);

    // fails-when: a held round's cancel leaves its hold pending, so an approve still runs it
    expect(await holdStatus(heldRunId)).toBe(HeldRunStatus.Rejected);
    expect((await runStatus(runId)).status).toBe(ExecutionRunStatus.enum.cancelled);
    expect(postCheckStatus).toHaveBeenCalledWith(
      SOURCE_REPO,
      `sha-${runId}`,
      CheckRunConclusion.enum.cancelled,
      'Rejected',
      expect.any(String),
      expect.anything(),
    );
    const { result: decision, onWorkflowRelease } = await approve(heldRunId);
    expect(decision.status).toBe('not-found');
    expect(onWorkflowRelease).not.toHaveBeenCalled();
    // The release's claim would fail too: the row is no longer held.
    expect(await tracker.claimHeldGlobalEvalRound(runId)).toBe(false);
  });

  it('refuses a cancel that lost to an approve and writes nothing', async () => {
    // breaks-if-wrong: a cancel must not reject a hold a decision already settled
    const { tracker, postCheckStatus, cancel } = harness();
    const { runId, heldRunId } = await holdRun(tracker, { round: false });
    await new HeldRunStore(db).approve(ORG_ID, heldRunId, 'bob');

    const result = await cancel(runId);

    // fails-when: the cancel stamps attribution and answers as a cancellation while
    // the approve's resume runs the run
    expect(result).toMatchObject({
      alreadyTerminal: false,
      decidedBeforeCancel: HeldRunWithdrawal.Approved,
    });
    expect(cancelRouteAnswer(result)).toEqual({
      httpStatus: 409,
      body: { error: RUN_RESUMING_AFTER_APPROVAL_MESSAGE, status: ExecutionRunStatus.enum.held },
      accessNote: 'run is resuming after approval',
    });
    const row = await db
      .selectFrom('execution_runs')
      .select(['status', 'cancelled_by', 'failure_reason'])
      .where('run_id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      status: ExecutionRunStatus.enum.held,
      cancelled_by: null,
      failure_reason: null,
    });
    expect(await holdStatus(heldRunId)).toBe(HeldRunStatus.Approved);
    expect(postCheckStatus).not.toHaveBeenCalled();
  });

  it('refuses a cancel that lost to a reject, naming the rejection', async () => {
    // breaks-if-wrong: the reject that won must stay the run's only decision
    const { tracker, postCheckStatus, cancel, dashboardCancel } = harness();
    const { runId, heldRunId } = await holdRun(tracker, { round: false });
    await new HeldRunStore(db).reject(ORG_ID, heldRunId, 'rejected by bob');

    const result = await cancel(runId);

    // fails-when: the refusal says the run is resuming after approval while a reject ends it
    expect(result.decidedBeforeCancel).toBe(HeldRunWithdrawal.Rejected);
    expect(cancelRouteAnswer(result)).toEqual({
      httpStatus: 409,
      body: { error: RUN_REJECTED_BEFORE_CANCEL_MESSAGE, status: ExecutionRunStatus.enum.held },
      accessNote: 'run was rejected before the cancel',
    });
    await expect(dashboardCancel(runId, 'user:alice', null)).rejects.toThrow(
      RUN_REJECTED_BEFORE_CANCEL_MESSAGE,
    );
    // The cancel wrote nothing: the reject's own path ends the run.
    expect(await runStatus(runId)).toEqual({
      status: ExecutionRunStatus.enum.held,
      cancelled_by: null,
    });
    expect(postCheckStatus).not.toHaveBeenCalled();
  });

  it('the dashboard, CLI and MCP cancel reports the refusal instead of a cancellation', async () => {
    const { tracker, dashboardCancel } = harness();
    const { runId, heldRunId } = await holdRun(tracker, { round: false });
    await new HeldRunStore(db).approve(ORG_ID, heldRunId, 'bob');

    // fails-when: the relay answers { cancelledJobs } and the Platform records a cancel
    await expect(dashboardCancel(runId, 'user:alice', null)).rejects.toThrow(
      RUN_RESUMING_AFTER_APPROVAL_MESSAGE,
    );
    expect((await runStatus(runId)).cancelled_by).toBeNull();
  });

  it('runs the hold rejection once per run when the run carries two workflow holds', async () => {
    const { tracker, postCheckStatus, cancel, rejectHeldWorkflow } = harness();
    const { runId, heldRunId } = await holdRun(tracker, { round: false });
    const store = new HeldRunStore(db);
    // A second workflow-scoped hold on the same run, under its own job id.
    const second = await store.create(ORG_ID, {
      ...buildSecurityHoldData(runId, {
        action: 'hold',
        reason: 'fork_pr',
        message: 'fork pull request',
        approvalExpirySeconds: null,
      }),
      jobId: `${INSTALL_JOB_ID_PREFIX}build`,
    });

    await cancel(runId);

    // fails-when: the rejection runs per hold, cancelling the run and posting the check twice
    expect(rejectHeldWorkflow).toHaveBeenCalledTimes(1);
    expect(postCheckStatus).toHaveBeenCalledTimes(1);
    expect(await holdStatus(heldRunId)).toBe(HeldRunStatus.Rejected);
    expect(await holdStatus(second.id)).toBe(HeldRunStatus.Rejected);
    expect((await runStatus(runId)).status).toBe(ExecutionRunStatus.enum.cancelled);
  });

  // ── A run that is not `held` but carries a dispatch-time approval request ──

  /**
   * A run that dispatch moved past `held`: its row reads `status`, and each
   * entry of `jobs` is an `execution_jobs` row. A hold raised at dispatch
   * leaves exactly this shape — a placeholder job and a pending `held_runs`
   * row — while the run itself stays `pending`/`running`.
   */
  async function seedActiveRun(
    status: ExecutionRunStatus,
    jobs: Array<{ jobId: string; status: ExecutionJobStatus }>,
  ): Promise<string> {
    const runId = randomUUID();
    await db
      .insertInto('execution_runs')
      .values({
        run_id: runId,
        routing_key: ROUTING_KEY,
        workflow_name: 'deploy',
        status,
        provider: 'github',
        repo_identifier: SOURCE_REPO,
        ref: 'main',
        sha: `sha-${runId}`,
        started_at: new Date(),
      })
      .execute();
    for (const job of jobs) {
      await db
        .insertInto('execution_jobs')
        .values({
          run_id: runId,
          job_id: job.jobId,
          routing_key: ROUTING_KEY,
          job_name: job.jobId,
          status: job.status,
        })
        .execute();
    }
    return runId;
  }

  /**
   * The workflow-scoped hold a workflow `approval` block raises on a root job,
   * with the pending `KiCI Security` check it posts recorded as posted.
   */
  async function holdRootJob(runId: string, jobId: string): Promise<string> {
    const store = new HeldRunStore(db);
    const hold = await store.createHold(ORG_ID, {
      runId,
      jobId,
      scope: HoldScope.enum.workflow,
      triggerSource: TriggerSource.enum.explicit,
      requirement: {
        clauses: [],
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        reason: 'Held for workflow approval',
      },
    } as unknown as Parameters<HeldRunStore['createHold']>[1]);
    await store.markPendingCheckPosted(ORG_ID, [hold.id]);
    return hold.id;
  }

  async function jobStatus(runId: string, jobId: string) {
    const row = await db
      .selectFrom('execution_jobs')
      .select(['status'])
      .where('run_id', '=', runId)
      .where('job_id', '=', jobId)
      .executeTakeFirstOrThrow();
    return row.status;
  }

  it('withdraws the dispatch-time hold of a running run and cancels the run', async () => {
    const { cancel, rejectHeldWorkflow, postCheckStatus, completeUndispatchedCheckRuns } =
      harness();
    const runId = await seedActiveRun(ExecutionRunStatus.enum.running, [
      { jobId: 'release', status: ExecutionJobStatus.enum.pending },
    ]);
    const heldRunId = await holdRootJob(runId, 'release');

    const result = await cancel(runId);

    expect(result.alreadyTerminal).toBe(false);
    expect(result.decidedBeforeCancel).toBeUndefined();
    // fails-when: a cancel of a non-held run takes only the job path and leaves
    // the approval request pending
    expect(await holdStatus(heldRunId)).toBe(HeldRunStatus.Rejected);
    // Once, and told the run is not held, so it settles the checks and leaves
    // the run row to the job cancellation.
    expect(rejectHeldWorkflow).toHaveBeenCalledTimes(1);
    expect(rejectHeldWorkflow).toHaveBeenCalledWith(expect.anything(), REASON, {
      runHeld: false,
    });
    // fails-when: the withdrawal skips the rejection, so the posted security
    // check stays pending on the commit
    expect(postCheckStatus).toHaveBeenCalledTimes(1);
    expect(postCheckStatus).toHaveBeenCalledWith(
      SOURCE_REPO,
      `sha-${runId}`,
      CheckRunConclusion.enum.cancelled,
      'Rejected',
      expect.any(String),
      expect.anything(),
    );
    // A hold raised at dispatch stores a per-job context, not the workflow
    // dispatch a pre-dispatch hold replays, so there is no undispatched check
    // set to close: the jobs' own checks close with the run.
    expect(completeUndispatchedCheckRuns).not.toHaveBeenCalled();
    expect(await jobStatus(runId, 'release')).toBe(ExecutionJobStatus.enum.cancelled);
    expect(await runStatus(runId)).toEqual({
      status: ExecutionRunStatus.enum.cancelled,
      cancelled_by: 'alice',
    });

    // A later approve finds nothing to release.
    const { result: decision, onWorkflowRelease } = await approve(heldRunId);
    expect(decision.status).toBe('not-found');
    expect(onWorkflowRelease).not.toHaveBeenCalled();
  });

  it('cancels the running job of a mixed run and rejects its held sibling', async () => {
    const send = vi.fn();
    const registry = {
      get: (agentId: string) =>
        agentId === 'agent-1' ? { ws: { readyState: 1, send } } : undefined,
    } as unknown as AgentRegistry;
    const jobQueue = new JobQueue(db, { maxDepth: 100, defaultTimeoutMs: 600_000 });
    vi.spyOn(jobQueue, 'getDispatchedJobOwnersByRunId').mockResolvedValue([
      { jobId: 'build', agentId: 'agent-1', ownerInstanceId: null },
    ]);
    const { cancel, rejectHeldWorkflow, postCheckStatus, completeUndispatchedCheckRuns } = harness({
      registry,
      jobQueue,
    });
    const runId = await seedActiveRun(ExecutionRunStatus.enum.running, [
      { jobId: 'build', status: ExecutionJobStatus.enum.running },
      { jobId: 'release', status: ExecutionJobStatus.enum.pending },
    ]);
    const heldRunId = await holdRootJob(runId, 'release');

    const result = await cancel(runId);

    // The running job is cancelled the ordinary way: its agent gets job.cancel
    // and reports its own terminal status.
    expect(result.agentsNotified).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0]![0] as string)).toMatchObject({
      type: 'job.cancel',
      runId,
      jobId: 'build',
    });
    expect(await jobStatus(runId, 'build')).toBe(ExecutionJobStatus.enum.running);
    // fails-when: the hold of a run that also has running work is left pending
    expect(await holdStatus(heldRunId)).toBe(HeldRunStatus.Rejected);
    expect(await jobStatus(runId, 'release')).toBe(ExecutionJobStatus.enum.cancelled);
    expect(rejectHeldWorkflow).toHaveBeenCalledTimes(1);
    expect(rejectHeldWorkflow).toHaveBeenCalledWith(expect.anything(), REASON, {
      runHeld: false,
    });
    expect(completeUndispatchedCheckRuns).not.toHaveBeenCalled();
    expect(postCheckStatus).toHaveBeenCalledTimes(1);
    expect(postCheckStatus).toHaveBeenCalledWith(
      SOURCE_REPO,
      `sha-${runId}`,
      CheckRunConclusion.enum.cancelled,
      'Rejected',
      expect.any(String),
      expect.anything(),
    );
    // The running job ends through its agent's own report, not a held-run write.
    expect((await runStatus(runId)).status).toBe(ExecutionRunStatus.enum.running);
  });

  it('cancels a run with no hold through the plain job path', async () => {
    // breaks-if-wrong: a run with no approval request must cancel exactly as before
    const { cancel, rejectHeldWorkflow, postCheckStatus } = harness();
    const runId = await seedActiveRun(ExecutionRunStatus.enum.running, [
      { jobId: 'build', status: ExecutionJobStatus.enum.pending },
    ]);

    const result = await cancel(runId);

    expect(result).toEqual({
      agentsNotified: 0,
      unreachable: 0,
      pendingCancelled: 1,
      alreadyTerminal: false,
    });
    expect(rejectHeldWorkflow).not.toHaveBeenCalled();
    expect(postCheckStatus).not.toHaveBeenCalled();
    expect(await jobStatus(runId, 'build')).toBe(ExecutionJobStatus.enum.cancelled);
    expect((await runStatus(runId)).status).toBe(ExecutionRunStatus.enum.cancelled);
  });
});
