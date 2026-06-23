/**
 * Execution state tracker with write-through DB persistence.
 *
 * Aggregates job/step status updates from agents and persists execution
 * history to PostgreSQL. Maintains in-memory state for fast lookups
 * (job name resolution, run completion detection) with write-through
 * to the execution_runs/execution_jobs/execution_steps tables.
 *
 * Overall run status follows locked decision:
 * - success ONLY if ALL jobs succeed
 * - failed if ANY job fails
 * - cancelled if ANY job is cancelled (and none failed)
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { createLogger, getRequestContext, toErrorMessage } from '@kici-dev/shared';
import {
  ExecutionJobStatus,
  ExecutionRunStatus,
  ExecutionStepStatus,
  type InitFailure,
  ScalerEventType,
  TERMINAL_JOB_STATES,
  CheckMode,
  CheckStepOutcome,
} from '@kici-dev/engine';
import { executionsTotal, executionDurationSeconds } from '../metrics/prometheus.js';
import type { ObserverRegistry } from '../ws/observer-registry.js';
import type { LogStorage } from './log-storage.js';
import type { JobQueue } from '../queue/job-queue.js';
import { evaluateDownstreams, checkSchedulerInvariant } from '../pipeline/needs-scheduler.js';
import { evaluateWave } from '../pipeline/wave-scheduler.js';

const logger = createLogger({ prefix: 'execution-tracker' });

/** How long to keep completed runs in memory before pruning (ms). */
const PRUNE_DELAY_MS = 5 * 60 * 1000; // 5 minutes

/** Context passed to onExecutionComplete for commit status updates. */
export interface ExecutionContext {
  workflowName: string;
  provider: string;
  repoIdentifier: string;
  sha: string;
  installationId?: number;
  requestId?: string;
  routingKey?: string;
  /** Git branch or tag (e.g. "main", "feature/foo"). */
  ref?: string;
  /** Trigger event type (e.g. "push", "pr:open"). */
  triggerEvent?: string;
  /** First line of the commit message. */
  commitMessage?: string;
  /** Parent run ID for re-run lineage (null/undefined for original runs). */
  parentRunId?: string | null;
  /** Root ancestor run ID for re-run lineage (null/undefined for original runs). */
  originalRunId?: string | null;
  /** User identity that triggered this re-run (null/undefined for webhook-triggered). */
  triggeredBy?: string | null;
  /** Workflow-level concurrency config from the lock file. */
  concurrency?: {
    cancelInProgress?: boolean;
    max?: number;
  };
}

/** Data passed to the onWorkflowComplete callback. */
interface WorkflowCompleteCallbackData {
  runId: string;
  workflowName: string;
  status: string;
  duration: number;
  jobResults: Array<{ name: string; status: string }>;
  routingKey?: string;
  repo: string;
}

/** Data passed to the onJobComplete callback. */
interface JobCompleteCallbackData {
  runId: string;
  jobId: string;
  jobName: string;
  status: string;
  routingKey?: string;
  repo: string;
  workflowName: string;
}

export interface ExecutionTrackerDeps {
  db: Kysely<Database>;
  /** Optional observer registry for broadcasting status/step/log events to CLI observers. */
  observerRegistry?: ObserverRegistry;
  /** Optional callback when execution reaches terminal state. */
  onExecutionComplete?: (
    runId: string,
    status: Extract<ExecutionRunStatus, 'success' | 'failed' | 'cancelled'>,
    context: ExecutionContext,
    description?: string,
  ) => void;
  /** Optional callback to forward step status to Platform. */
  onStepStatusForward?: (
    runId: string,
    jobId: string,
    jobName: string,
    stepIndex: number,
    stepName: string,
    state: string,
    timestamp: number,
    data?: Record<string, unknown>,
    requestId?: string,
  ) => void;
  /** Optional callback when a completed run is pruned from memory. */
  onRunPruned?: (runId: string) => void;
  /** Optional callback when a workflow run reaches terminal state (for system event emission). */
  onWorkflowComplete?: (data: WorkflowCompleteCallbackData) => void;
  /** Optional callback when a job reaches terminal state (for system event emission). */
  onJobComplete?: (data: JobCompleteCallbackData) => void;
  /**
   * Optional callback to forward execution status changes to Platform.
   * Fires at run start (status=pending), on first job running, and run completion.
   * Used by Platform StaleOrchDetector to track active runs.
   */
  onExecutionStatusChange?: (
    runId: string,
    status: ExecutionRunStatus,
    context: ExecutionContext,
    jobCount: number,
    startedAt: number,
    completedAt?: number,
    durationMs?: number,
    failureReason?: string,
    /**
     * Total raw log bytes accumulated across the run (sum of per-job totals).
     * Set on terminal run states only. Powers the operator-side
     * `kici_org_log_bytes` capacity-planning gauge on the Platform.
     */
    logBytes?: number,
    /**
     * Structured init-failure signal. Set when the run never executed a step
     * because of an init-phase failure. Forwarded to Platform's execution.status
     * forward and persisted in execution_runs.init_failure on both sides.
     */
    initFailure?: InitFailure,
  ) => void;
  /** Optional callback to forward job status changes to Platform.
   *  Fires on every job state transition (pending->running, running->success, etc.).
   *  Used to populate Platform's execution_jobs projection table. */
  onJobStatusChange?: (
    runId: string,
    jobId: string,
    jobName: string,
    status: string,
    timestamp: number,
    startedAt?: number,
    completedAt?: number,
    durationMs?: number,
    errorMessage?: string,
    agentId?: string,
    runsOnLabels?: string[],
    /**
     * Total raw log bytes accumulated across the job (sum of per-step totals).
     * Set on terminal job states only.
     */
    logBytes?: number,
    /**
     * Structured init-failure signal. Set for synthetic rejected-* / init-failed-*
     * jobs that never started. Persisted in execution_jobs.init_failure.
     */
    initFailure?: InitFailure,
  ) => void;
  /**
   * Optional callback to emit run.event messages to Platform.
   * Fires at orchestrator lifecycle points (dispatch, agent assignment, job start/complete).
   *
   * SECURITY: this payload MUST NOT carry an `orgId` (or any tenant identifier).
   * The Platform always uses `authState.orgId` for tenant attribution; trusting
   * a wire-supplied field is a cross-tenant injection primitive. See
   * `docs/architecture/security/ws-tenant-isolation.md`.
   */
  onRunEventEmit?: (event: {
    runId: string;
    eventType: string;
    timestampMs: number;
    sourceService: 'orchestrator' | 'agent';
    jobId?: string | null;
    metadata?: Record<string, unknown>;
    durationMs?: number | null;
  }) => void;
  /** Optional log storage for writing per-job orchestration logs (JSONL). */
  logStorage?: LogStorage;
  /** Org ID for this orchestrator instance (used in run.event emission). */
  orgId?: string;
  /** Optional job queue for cascading run failures to dispatch_queue entries. */
  jobQueue?: JobQueue;
}

/** In-memory state for a single execution run. */
interface RunState {
  /** Current run-level status (pending until first job starts running). */
  status: Extract<ExecutionRunStatus, 'pending' | 'running' | 'cancelling'>;
  workflowName: string;
  provider: string;
  repoIdentifier: string;
  sha: string;
  installationId?: number;
  requestId?: string;
  routingKey?: string;
  ref?: string;
  triggerEvent?: string;
  commitMessage?: string;
  parentRunId?: string | null;
  originalRunId?: string | null;
  triggeredBy?: string | null;
  concurrency?: { cancelInProgress?: boolean; max?: number };
  failureReason?: string;
  /** Run mode for idempotent steps (`apply` | `check` | `check-fail-on-drift`). */
  checkMode?: string;
  /** Set true once any step reports a `dry-run` outcome (drift detected). */
  driftDetected?: boolean;
  startedAt: number;
  completedAt?: number;
  jobs: Map<
    string,
    { name: string; status: string; startedAt?: number; agentId?: string; runsOnLabels?: string[] }
  >;
}

export class ExecutionTracker {
  private readonly db: Kysely<Database>;
  private readonly observerRegistry?: ObserverRegistry;
  private readonly onExecutionComplete?: ExecutionTrackerDeps['onExecutionComplete'];
  private readonly onStepStatusForward?: ExecutionTrackerDeps['onStepStatusForward'];
  private readonly onRunPruned?: ExecutionTrackerDeps['onRunPruned'];
  private readonly onWorkflowComplete?: ExecutionTrackerDeps['onWorkflowComplete'];
  private readonly onJobComplete?: ExecutionTrackerDeps['onJobComplete'];
  private readonly onExecutionStatusChange?: ExecutionTrackerDeps['onExecutionStatusChange'];
  private readonly onJobStatusChange?: ExecutionTrackerDeps['onJobStatusChange'];
  private readonly onRunEventEmit?: ExecutionTrackerDeps['onRunEventEmit'];
  private readonly logStorage?: LogStorage;
  private readonly orgId?: string;
  private readonly jobQueue?: JobQueue;
  private readonly runs = new Map<string, RunState>();
  /**
   * Per-run async-mutex chain. `onJobStatus` and `addJobsToRun` mutate the same
   * `run.jobs` Map / `execution_jobs` row; without serialization a job-status
   * reply that lands mid synthetic→real swap (`addJobsToRun`) clobbers the swap
   * and the run hangs in `running` forever (see `withRunLock`). The map value is
   * the tail of the chain for that runId; entries are GC'd when the last holder
   * releases.
   */
  private readonly runLockTails = new Map<string, Promise<unknown>>();
  /**
   * Tracks which runIds the current async context already holds in
   * `withRunLock`, so reentrant calls (e.g. onJobStatus → scheduler hook →
   * dispatchReadyJob → addJobsToRun, all the same runId) bypass re-acquisition
   * instead of deadlocking. Propagates across awaits via AsyncLocalStorage.
   */
  private readonly heldRunLocks = new AsyncLocalStorage<Set<string>>();
  /** Tracks which runs are test runs for observer broadcasting. */
  private readonly testRunIds = new Set<string>();
  /**
   * Per-(run, job) raw log byte accumulator.
   *
   * Populated from the agent-reported `logBytesStreamed` field on terminal
   * `step.status` messages and folded into `execution_jobs.log_bytes` when
   * the job reaches terminal state. The per-run total is then computed by
   * summing the per-job entries and written into `execution_runs.log_bytes`
   * at run completion. Deleted on run prune to avoid Map growth.
   *
   * Map shape: runId -> jobId -> bytes.
   */
  private readonly jobLogBytes = new Map<string, Map<string, number>>();
  /** Callback fired when a job's needs are satisfied and it's ready for dispatch. */
  onJobReadyCallback?: (runId: string, jobName: string) => Promise<void>;

  constructor(deps: ExecutionTrackerDeps) {
    this.db = deps.db;
    this.observerRegistry = deps.observerRegistry;
    this.onExecutionComplete = deps.onExecutionComplete;
    this.onStepStatusForward = deps.onStepStatusForward;
    this.onRunPruned = deps.onRunPruned;
    this.onWorkflowComplete = deps.onWorkflowComplete;
    this.onJobComplete = deps.onJobComplete;
    this.onExecutionStatusChange = deps.onExecutionStatusChange;
    this.onJobStatusChange = deps.onJobStatusChange;
    this.onRunEventEmit = deps.onRunEventEmit;
    this.logStorage = deps.logStorage;
    this.orgId = deps.orgId;
    this.jobQueue = deps.jobQueue;
  }

  /**
   * Register a callback fired when a job's needs become satisfied.
   * The processor sets this to dispatch newly-ready jobs to agents.
   */
  setOnJobReadyCallback(cb: (runId: string, jobName: string) => Promise<void>): void {
    this.onJobReadyCallback = cb;
  }

  /**
   * Record a new execution run with its initial jobs.
   *
   * Inserts execution_runs and execution_jobs rows in the DB and
   * sets up in-memory tracking state.
   */
  async onExecutionStarted(
    runId: string,
    workflowName: string,
    provider: string,
    repoIdentifier: string,
    ref: string,
    sha: string,
    deliveryId: string | null,
    providerContext: Record<string, unknown>,
    triggerDecision: Record<string, unknown> | null,
    jobs: Array<{
      jobId: string;
      jobName: string;
      matrixValues?: Record<string, unknown>;
      runsOnLabels?: string[];
      baseJobName?: string;
      variantKind?: string;
      variantLabel?: string;
      waveGated?: boolean;
      waveMaxParallel?: number;
      waveFailFast?: boolean;
    }>,
    routingKey?: string,
    /** Secret context names dispatched with jobs (for context-disable job lookup). */
    dispatchedContexts?: string[],
    /** Trigger event type (e.g. "push", "pr:open") for dashboard display. */
    triggerEvent?: string,
    /** First line of commit message for dashboard display. */
    commitMessage?: string,
    /** Parent run ID for re-run lineage. */
    parentRunId?: string | null,
    /** User identity that triggered this re-run. */
    triggeredBy?: string | null,
    /** Root ancestor run ID for re-run lineage. */
    originalRunId?: string | null,
    /** Workflow-level concurrency config from the lock file. */
    concurrency?: { cancelInProgress?: boolean; max?: number },
    /** Workflow-level wall-clock timeout in ms from the lock file. Sets the run deadline. */
    workflowTimeoutMs?: number,
    /** Run mode for idempotent steps; non-apply labels the run a check-mode preview. */
    checkMode?: string,
  ): Promise<void> {
    const now = new Date();

    // In-memory state
    const jobMap = new Map<
      string,
      {
        name: string;
        status: string;
        startedAt?: number;
        agentId?: string;
        runsOnLabels?: string[];
      }
    >();
    for (const job of jobs) {
      jobMap.set(job.jobId, {
        name: job.jobName,
        status: ExecutionJobStatus.enum.pending,
        ...(job.runsOnLabels?.length && { runsOnLabels: job.runsOnLabels }),
      });
    }

    // Extract installationId from providerContext for commit status updates
    const installationId =
      typeof (providerContext as Record<string, unknown>).installationId === 'number'
        ? ((providerContext as Record<string, unknown>).installationId as number)
        : undefined;

    this.runs.set(runId, {
      status: ExecutionRunStatus.enum.pending,
      workflowName,
      provider,
      repoIdentifier,
      sha,
      installationId,
      requestId: getRequestContext().requestId,
      routingKey,
      ref,
      triggerEvent,
      commitMessage,
      parentRunId,
      originalRunId,
      triggeredBy,
      concurrency,
      ...(checkMode != null && { checkMode }),
      startedAt: now.getTime(),
      jobs: jobMap,
    });

    // DB: insert execution run (ON CONFLICT DO NOTHING handles the case where
    // the run was already created by the deferred-init early-creation path)
    await this.db
      .insertInto('execution_runs')
      .values({
        run_id: runId,
        routing_key: routingKey ?? null,
        workflow_name: workflowName,
        status: ExecutionRunStatus.enum.pending,
        provider,
        repo_identifier: repoIdentifier,
        ref,
        sha,
        delivery_id: deliveryId,
        trigger_decision: triggerDecision ? JSON.stringify(triggerDecision) : null,
        provider_context: JSON.stringify(providerContext),
        started_at: now,
        ...(parentRunId != null && { parent_run_id: parentRunId }),
        ...(originalRunId != null && { original_run_id: originalRunId }),
        ...(triggeredBy != null && { triggered_by: triggeredBy }),
        ...(workflowTimeoutMs != null && { workflow_timeout_ms: workflowTimeoutMs }),
        ...(checkMode != null && { check_mode: checkMode }),
      })
      .onConflict((oc) => oc.column('run_id').doNothing())
      .execute();

    // DB: insert execution jobs (upsert to handle race with onJobStatus)
    if (jobs.length > 0) {
      for (const job of jobs) {
        const runsOnLabelsJson = job.runsOnLabels?.length ? JSON.stringify(job.runsOnLabels) : null;
        await this.db
          .insertInto('execution_jobs')
          .values({
            run_id: runId,
            job_id: job.jobId,
            job_name: job.jobName,
            // Denormalized — see migration 006. Cold-store partitions by
            // routing_key, and we don't want to JOIN execution_runs in
            // every archive cycle.
            routing_key: routingKey ?? null,
            matrix_values: job.matrixValues ? JSON.stringify(job.matrixValues) : null,
            ...(job.baseJobName && { base_job_name: job.baseJobName }),
            ...(job.variantKind && { variant_kind: job.variantKind }),
            ...(job.variantLabel && { variant_label: job.variantLabel }),
            ...(job.waveGated && { wave_gated: true }),
            ...(job.waveMaxParallel !== undefined && { wave_max_parallel: job.waveMaxParallel }),
            ...(job.waveFailFast !== undefined && { wave_fail_fast: job.waveFailFast }),
            ...(runsOnLabelsJson && { runs_on_labels: runsOnLabelsJson }),
            ...(dispatchedContexts?.length && {
              dispatched_contexts: JSON.stringify(dispatchedContexts),
            }),
          })
          .onConflict((oc) =>
            oc.columns(['run_id', 'job_id']).doUpdateSet({
              job_name: job.jobName,
              ...(job.baseJobName && { base_job_name: job.baseJobName }),
              ...(job.variantKind && { variant_kind: job.variantKind }),
              ...(job.variantLabel && { variant_label: job.variantLabel }),
              ...(job.waveGated && { wave_gated: true }),
              ...(job.waveMaxParallel !== undefined && { wave_max_parallel: job.waveMaxParallel }),
              ...(job.waveFailFast !== undefined && { wave_fail_fast: job.waveFailFast }),
              ...(runsOnLabelsJson && { runs_on_labels: runsOnLabelsJson }),
              ...(dispatchedContexts?.length && {
                dispatched_contexts: JSON.stringify(dispatchedContexts),
              }),
            }),
          )
          .execute();
      }
    }

    executionsTotal.add(1, { status: ExecutionRunStatus.enum.pending });

    logger.info('Execution started', {
      runId,
      workflowName,
      jobCount: jobs.length,
    });

    // Emit orchestrator.dispatch run event
    this.emitRunEvent(runId, 'orchestrator.dispatch', {
      metadata: { workflowName, triggerType: triggerEvent },
    });

    // Write orchestration log for each dispatched job
    for (const job of jobs) {
      this.writeOrchLog(runId, job.jobId, 'dispatch', 'Job dispatched to queue');
    }

    // Fire status change callback for Platform forwarding (pending)
    this.onExecutionStatusChange?.(
      runId,
      ExecutionRunStatus.enum.pending,
      {
        workflowName,
        provider,
        repoIdentifier,
        sha,
        installationId,
        requestId: getRequestContext().requestId,
        routingKey,
        ref,
        triggerEvent,
        commitMessage,
        parentRunId,
        originalRunId,
        triggeredBy,
      },
      jobs.length,
      now.getTime(),
    );
  }

  /**
   * Add additional jobs to an already-started execution run.
   * Used when build jobs are tracked early and regular jobs are dispatched later.
   */
  /**
   * Find the synthetic needs-pending job ID for a given job name in a run.
   * Used by dispatchReadyJob to locate the placeholder entry before replacing it.
   *
   * Cluster correctness: the synthetic row is inserted by the peer that
   * ingested the webhook. In an HA cluster `dispatchReadyJob` can fire on a
   * different peer whose in-memory map has no entry for this run. Fall back
   * to the DB so the leftover synthetic row gets cleaned up regardless of
   * which peer owns the downstream dispatch.
   */
  async findSyntheticJobId(runId: string, jobName: string): Promise<string | undefined> {
    const run = this.runs.get(runId);
    const prefix = `needs-pending-${jobName}-`;
    if (run) {
      for (const key of run.jobs.keys()) {
        if (key.startsWith(prefix)) return key;
      }
    }

    const row = await this.db
      .selectFrom('execution_jobs')
      .select('job_id')
      .where('run_id', '=', runId)
      .where('job_name', '=', jobName)
      .where('job_id', 'like', `${prefix}%`)
      .executeTakeFirst();

    return row?.job_id;
  }

  /**
   * Find the synthetic deferred-eval placeholder job ID for a result-aware
   * dynamic generator's eval job. Mirrors {@link findSyntheticJobId} but keys on
   * the `dynamic-eval-pending-<evalJobName>-` prefix that registerDeferredEvalJob
   * uses, so dispatchEvalJob can swap it for the real eval job id.
   */
  async findDynamicEvalSyntheticId(
    runId: string,
    evalJobName: string,
  ): Promise<string | undefined> {
    const run = this.runs.get(runId);
    const prefix = `dynamic-eval-pending-${evalJobName}-`;
    if (run) {
      for (const key of run.jobs.keys()) {
        if (key.startsWith(prefix)) return key;
      }
    }

    const row = await this.db
      .selectFrom('execution_jobs')
      .select('job_id')
      .where('run_id', '=', runId)
      .where('job_name', '=', evalJobName)
      .where('job_id', 'like', `${prefix}%`)
      .executeTakeFirst();

    return row?.job_id;
  }

  /**
   * Durably mark the projected `execution_jobs` row so run-recovery sweepers
   * know this job lives on a remote worker peer and must not be force-failed
   * while that worker is connected. Called by the owning coordinator right
   * after a peer ACKs a reroute.
   */
  async markJobReroutedToPeer(runId: string, jobId: string, peerId: string): Promise<void> {
    await this.db
      .updateTable('execution_jobs')
      .set({ rerouted_to_peer: peerId })
      .where('run_id', '=', runId)
      .where('job_id', '=', jobId)
      .execute();
  }

  /**
   * Run `fn` while holding a per-run lock, serializing the run-mutating methods
   * (`onJobStatus`, `addJobsToRun`) so a status reply cannot interleave with the
   * synthetic→real job swap and wedge the run in `running`.
   *
   * The lock is **reentrant**: three paths re-enter a locked method within the
   * same async context for the same runId — onJobStatus → scheduler hook →
   * dispatchReadyJob → addJobsToRun; onJobStatus → enforceSchedulerInvariant →
   * onJobStatus; runSchedulerHook → onJobStatus (skip). A non-reentrant mutex
   * would deadlock on these, so a context that already holds the runId's lock
   * (tracked via `heldRunLocks`) runs `fn` inline. A genuinely concurrent caller
   * for the same runId (a separate WS message) is a different async context and
   * correctly waits. All reentrant paths are same-runId, so there is no
   * cross-run lock-ordering deadlock.
   */
  private async withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const held = this.heldRunLocks.getStore();
    if (held?.has(runId)) {
      // Reentrant: this async context already holds runId's lock — run inline.
      return fn();
    }

    const prev = this.runLockTails.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prev.then(() => mine);
    this.runLockTails.set(runId, chained);

    // Wait our turn. Never inherit a prior holder's rejection — each op owns its
    // own error handling; the chain only orders them.
    await prev.catch(() => {});

    const nextHeld = new Set(this.heldRunLocks.getStore() ?? []);
    nextHeld.add(runId);
    try {
      return await this.heldRunLocks.run(nextHeld, fn);
    } finally {
      release();
      // GC the tail when we were the last holder (no one chained after us).
      if (this.runLockTails.get(runId) === chained) {
        this.runLockTails.delete(runId);
      }
    }
  }

  async addJobsToRun(
    runId: string,
    jobs: Array<{
      jobId: string;
      jobName: string;
      matrixValues?: Record<string, unknown>;
      runsOnLabels?: string[];
      baseJobName?: string;
      variantKind?: string;
      variantLabel?: string;
    }>,
    dispatchedContexts?: string[],
    /** Synthetic job ID to replace (e.g. needs-pending-deploy-{uuid}). */
    replaceSyntheticId?: string,
  ): Promise<void> {
    // Serialize the synthetic→real swap against any concurrent onJobStatus for
    // the same run (see withRunLock). Reentrant when called from within an
    // already-locked onJobStatus (the scheduler-hook dispatch path).
    return this.withRunLock(runId, () =>
      this.addJobsToRunImpl(runId, jobs, dispatchedContexts, replaceSyntheticId),
    );
  }

  private async addJobsToRunImpl(
    runId: string,
    jobs: Array<{
      jobId: string;
      jobName: string;
      matrixValues?: Record<string, unknown>;
      runsOnLabels?: string[];
      baseJobName?: string;
      variantKind?: string;
      variantLabel?: string;
    }>,
    dispatchedContexts?: string[],
    replaceSyntheticId?: string,
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      logger.warn('addJobsToRun: run not found in memory', { runId });
      return;
    }

    // Remove synthetic entry if replacing with a real job ID.
    // Cluster correctness: the synthetic row may live in the shared DB even
    // when this peer's in-memory run.jobs doesn't know about it (the
    // ingesting peer inserted it; the dispatching peer received only the
    // rerouted upstream job via onExecutionStarted). Delete from DB
    // unconditionally whenever replaceSyntheticId is provided.
    if (replaceSyntheticId) {
      run.jobs.delete(replaceSyntheticId);
      await this.db
        .deleteFrom('execution_jobs')
        .where('run_id', '=', runId)
        .where('job_id', '=', replaceSyntheticId)
        .execute();
      logger.info('Replaced synthetic job entry with real job', {
        runId,
        syntheticId: replaceSyntheticId,
        realJobId: jobs[0]?.jobId,
      });
    }

    // Update in-memory state. A downstream job's status can arrive BEFORE this
    // synthetic→real swap finishes: the scheduler fires onJobReady (→
    // dispatchReadyJob → here) on a job's terminal transition, but the dispatched
    // agent — a fast mock or a no-op job — may report the new job's terminal
    // status before dispatchReadyJob's addJobsToRun call lands. That early
    // status update went through onJobStatus, which recovered the real job into
    // run.jobs (and the DB) with its terminal status. Blindly resetting to
    // `pending` here would clobber that terminal status, leaving the job
    // permanently non-terminal and the run stuck in `running` forever. So we
    // preserve any already-terminal status (from the in-memory entry or the DB
    // row) instead of overwriting it.
    const reEvaluateCompletion = new Set<string>();
    for (const job of jobs) {
      const existing = run.jobs.get(job.jobId);
      let status: string = ExecutionJobStatus.enum.pending;
      let preservedStartedAt: number | undefined;
      let preservedAgentId: string | undefined;
      if (existing && TERMINAL_JOB_STATES.has(existing.status)) {
        status = existing.status;
        preservedStartedAt = existing.startedAt;
        preservedAgentId = existing.agentId;
      } else {
        // The early status update may have upserted the DB row to terminal
        // without the in-memory entry being present at the time (e.g. it was
        // the synthetic id that lived in run.jobs, not the real id). Consult
        // the DB so we don't reset a terminal DB status back to pending.
        const dbRow = await this.db
          .selectFrom('execution_jobs')
          .select('status')
          .where('run_id', '=', runId)
          .where('job_id', '=', job.jobId)
          .executeTakeFirst();
        if (dbRow && TERMINAL_JOB_STATES.has(dbRow.status)) {
          status = dbRow.status;
        }
      }
      if (TERMINAL_JOB_STATES.has(status)) {
        reEvaluateCompletion.add(job.jobId);
      }
      run.jobs.set(job.jobId, {
        name: job.jobName,
        status,
        ...(preservedStartedAt !== undefined && { startedAt: preservedStartedAt }),
        ...(preservedAgentId !== undefined && { agentId: preservedAgentId }),
        ...(job.runsOnLabels?.length && { runsOnLabels: job.runsOnLabels }),
      });
    }

    // DB: insert additional execution_jobs rows (upsert to handle race with onJobStatus)
    if (jobs.length > 0) {
      for (const job of jobs) {
        const runsOnLabelsJson = job.runsOnLabels?.length ? JSON.stringify(job.runsOnLabels) : null;
        await this.db
          .insertInto('execution_jobs')
          .values({
            run_id: runId,
            job_id: job.jobId,
            job_name: job.jobName,
            // Denormalized — see migration 006.
            routing_key: run.routingKey ?? null,
            matrix_values: job.matrixValues ? JSON.stringify(job.matrixValues) : null,
            ...(job.baseJobName && { base_job_name: job.baseJobName }),
            ...(job.variantKind && { variant_kind: job.variantKind }),
            ...(job.variantLabel && { variant_label: job.variantLabel }),
            ...(runsOnLabelsJson && { runs_on_labels: runsOnLabelsJson }),
            ...(dispatchedContexts?.length && {
              dispatched_contexts: JSON.stringify(dispatchedContexts),
            }),
          })
          .onConflict((oc) =>
            oc.columns(['run_id', 'job_id']).doUpdateSet({
              job_name: job.jobName,
              ...(job.baseJobName && { base_job_name: job.baseJobName }),
              ...(job.variantKind && { variant_kind: job.variantKind }),
              ...(job.variantLabel && { variant_label: job.variantLabel }),
              ...(runsOnLabelsJson && { runs_on_labels: runsOnLabelsJson }),
              ...(dispatchedContexts?.length && {
                dispatched_contexts: JSON.stringify(dispatchedContexts),
              }),
            }),
          )
          .execute();
      }
    }

    // Write orchestration log for each new job
    for (const job of jobs) {
      this.writeOrchLog(runId, job.jobId, 'dispatch', 'Job dispatched to queue');
    }

    // Fire status change callback with updated job count (preserve current status)
    this.onExecutionStatusChange?.(
      runId,
      run.status,
      {
        workflowName: run.workflowName,
        provider: run.provider,
        repoIdentifier: run.repoIdentifier,
        sha: run.sha,
        installationId: run.installationId,
        requestId: run.requestId,
        routingKey: run.routingKey,
        ref: run.ref,
        triggerEvent: run.triggerEvent,
        commitMessage: run.commitMessage,
        parentRunId: run.parentRunId,
        originalRunId: run.originalRunId,
        triggeredBy: run.triggeredBy,
      },
      run.jobs.size,
      run.startedAt,
    );

    // Re-evaluate run completion when a just-added job is already terminal.
    // The early-arriving status update (handled in onJobStatus) ran its own
    // completion check, but at that point the synthetic placeholder this swap
    // just removed was still in run.jobs / the DB and blocked completion. Now
    // that the synthetic row is gone and the real row carries its terminal
    // status, the run may be complete — but nothing else will drive the check
    // (no further job.status messages are coming for an already-finished job).
    // Without this, a run whose last job finished before its synthetic→real
    // swap would hang in `running` forever.
    if (reEvaluateCompletion.size > 0 && !run.completedAt && this.isRunComplete(runId)) {
      const stopAfterStuckCheck = await this.enforceSchedulerInvariantOrFail(runId);
      if (!stopAfterStuckCheck && !run.completedAt && this.isRunComplete(runId)) {
        await this.finalizeRunCompletion(run, runId, Date.now(), new Date());
      }
    }
  }

  /**
   * Mark a run as a test run for observer broadcasting.
   * Called by the test pipeline after creating the execution run.
   */
  markTestRun(runId: string): void {
    this.testRunIds.add(runId);
  }

  /**
   * Check if a run is a test run.
   */
  isTestRun(runId: string): boolean {
    return this.testRunIds.has(runId);
  }

  /**
   * Update job status within a run.
   *
   * On terminal states (success/failed/cancelled), checks if ALL jobs
   * in the run are terminal. If so, computes overall run status and
   * fires the onExecutionComplete callback.
   */
  async onJobStatus(
    runId: string,
    jobId: string,
    state: string,
    timestamp: number,
    agentId?: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    // Serialize per-run against a concurrent addJobsToRun synthetic→real swap
    // (see withRunLock). Reentrant for the in-context recursions
    // (enforceSchedulerInvariantOrFail → onJobStatus, runSchedulerHook skip →
    // onJobStatus), which run inline rather than deadlocking.
    return this.withRunLock(runId, () =>
      this.onJobStatusImpl(runId, jobId, state, timestamp, agentId, data),
    );
  }

  private async onJobStatusImpl(
    runId: string,
    jobId: string,
    state: string,
    timestamp: number,
    agentId?: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    let run = this.runs.get(runId);
    let job = run?.jobs.get(jobId);

    // Recovery path: if in-memory state is missing (e.g. failRun deleted it
    // before the agent picked up a queued job), try to reconstruct it from
    // the DB so that run completion and Platform forwarding still work.
    if (!run) {
      const recovered = await this.recoverRunFromDb(runId, jobId, state);
      if (!recovered) return;
      run = recovered;
    }

    // If we have the run but not this job, look up job_name from dispatch_queue
    // and add it to in-memory tracking.
    if (run && !job) {
      job = await this.recoverJobFromDispatchQueue(run, runId, jobId);
    }

    // Idempotency guard: a replayed terminal status for a job already in that
    // same terminal state is a no-op. Re-applying it would re-fire onJobComplete
    // and re-run finalizeRunCompletion (double-notify). Returning early here
    // resolves the promise normally, so a coordinator that acks-after-apply
    // still acks the replay and the worker can prune its durable outbox.
    if (job && job.status === state && TERMINAL_JOB_STATES.has(state)) {
      return;
    }

    // Only set started_at on the FIRST running message. Build jobs send
    // multiple running messages (deps_installed, bundle_compiled) which
    // would overwrite started_at to near-completion time, causing
    // started_at ≈ completed_at and zero-width Gantt bars.
    const isFirstRunning = state === ExecutionJobStatus.enum.running && !job?.startedAt;
    const now = new Date(timestamp);

    // Update in-memory state
    if (job) {
      job.status = state;
      if (isFirstRunning) {
        job.startedAt = timestamp;
      }
      if (agentId && !job.agentId) {
        job.agentId = agentId;
      }
    }

    // DB upsert + run-level transitions
    const jobLogBytesTotal = await this.persistJobStatusUpdate({
      runId,
      jobId,
      state,
      timestamp,
      agentId,
      data,
      run,
      job,
      now,
      isFirstRunning,
    });

    await this.maybeTransitionRunToRunning(run, runId, jobId, state);
    await this.maybeTransitionRunToCancelling(run, runId, state);

    this.emitJobLifecycleEvents(runId, jobId, state, timestamp, agentId, job);
    this.fireJobStatusChangeCallback({
      runId,
      jobId,
      state,
      timestamp,
      isFirstRunning,
      job,
      data,
      jobLogBytesTotal,
    });

    // Broadcast job status change to observers (test runs only)
    if (this.observerRegistry && this.testRunIds.has(runId) && job) {
      this.observerRegistry.broadcastStatus(runId, state, job.name);
    }

    if (TERMINAL_JOB_STATES.has(state)) {
      await this.reconcileOrphanedSteps(runId, jobId, state, now);
    }

    // Fire onJobComplete callback when a job reaches terminal state
    if (TERMINAL_JOB_STATES.has(state) && run && job) {
      this.onJobComplete?.({
        runId,
        jobId,
        jobName: job.name,
        status: state,
        routingKey: run.routingKey,
        repo: run.repoIdentifier,
        workflowName: run.workflowName,
      });
    }

    if (TERMINAL_JOB_STATES.has(state) && data?.droppedJobs && Array.isArray(data.droppedJobs)) {
      await this.handleDriftDroppedJobs(runId, data.droppedJobs as string[]);
    }

    if (TERMINAL_JOB_STATES.has(state) && job) {
      await this.runSchedulerHook(runId, jobId, job.name, state);
      await this.runWaveSchedulerHook(runId, jobId, state);
    }

    // Check for run completion (with stuck-jobs invariant enforcement)
    if (TERMINAL_JOB_STATES.has(state) && run && this.isRunComplete(runId)) {
      const stopAfterStuckCheck = await this.enforceSchedulerInvariantOrFail(runId);
      if (stopAfterStuckCheck) return;
    }

    if (TERMINAL_JOB_STATES.has(state) && run && this.isRunComplete(runId)) {
      await this.finalizeRunCompletion(run, runId, timestamp, now);
    }
  }

  /**
   * Phase 1a: recover run state from the DB when in-memory tracking is empty.
   * Returns the rehydrated RunState or null if the run is unknown to the DB
   * (in which case the caller skips this status update entirely).
   */
  private async recoverRunFromDb(
    runId: string,
    jobId: string,
    state: string,
  ): Promise<RunState | null> {
    const dbRun = await this.db
      .selectFrom('execution_runs')
      .select([
        'status',
        'workflow_name',
        'provider',
        'repo_identifier',
        'sha',
        'ref',
        'routing_key',
        'provider_context',
        'started_at',
        'parent_run_id',
        'original_run_id',
        'triggered_by',
        'check_mode',
      ])
      .where('run_id', '=', runId)
      .executeTakeFirst();

    if (!dbRun) {
      // Run not found in DB either — it was cleaned up (e.g. warm-start purge).
      // Skip this job status update entirely; there's nothing to track.
      logger.warn('Run not found in DB, skipping job status update', { runId, jobId, state });
      return null;
    }

    // Recover drift state for check-fail-on-drift: a restart mid-check-run must
    // still fail the run if any persisted step already reported drift.
    let recoveredDriftDetected = false;
    if (dbRun.check_mode === CheckMode.enum['check-fail-on-drift']) {
      const driftRow = await this.db
        .selectFrom('execution_steps')
        .select('id')
        .where('run_id', '=', runId)
        .where('check_outcome', '=', CheckStepOutcome.enum['dry-run'])
        .executeTakeFirst();
      recoveredDriftDetected = driftRow != null;
    }

    const providerCtx =
      typeof dbRun.provider_context === 'string'
        ? JSON.parse(dbRun.provider_context)
        : (dbRun.provider_context ?? {});
    const installationId =
      typeof providerCtx.installationId === 'number'
        ? (providerCtx.installationId as number)
        : undefined;

    const recoveredRun: RunState = {
      status: (dbRun.status === ExecutionRunStatus.enum.pending ||
      dbRun.status === ExecutionRunStatus.enum.cancelling
        ? dbRun.status
        : ExecutionRunStatus.enum.running) as RunState['status'],
      workflowName: dbRun.workflow_name,
      provider: dbRun.provider,
      repoIdentifier: dbRun.repo_identifier,
      sha: dbRun.sha,
      installationId,
      requestId: undefined,
      routingKey: dbRun.routing_key ?? undefined,
      ref: dbRun.ref,
      triggerEvent: undefined,
      commitMessage: undefined,
      parentRunId: dbRun.parent_run_id ?? undefined,
      originalRunId: dbRun.original_run_id ?? undefined,
      triggeredBy: dbRun.triggered_by ?? undefined,
      ...(dbRun.check_mode != null && { checkMode: dbRun.check_mode }),
      ...(recoveredDriftDetected && { driftDetected: true }),
      jobs: new Map(),
      startedAt: new Date(dbRun.started_at).getTime(),
    };
    this.runs.set(runId, recoveredRun);

    logger.info('Recovered in-memory run state from DB', { runId });

    // If the run was prematurely marked as failed (e.g. "No agents available
    // to dispatch jobs" but a queued job is now running), reset to running.
    // The run completion logic will set the correct final status.
    // Do NOT reset runs that failed due to build failures — those are
    // intentionally terminal (the build timed out or errored).
    await this.db
      .updateTable('execution_runs')
      .set({ status: ExecutionRunStatus.enum.running, completed_at: null, duration_ms: null })
      .where('run_id', '=', runId)
      .where('status', '=', ExecutionRunStatus.enum.failed)
      .where((eb) =>
        eb.or([
          eb('failure_reason', 'is', null),
          eb(sql`lower(failure_reason)`, 'not like', '%build%'),
        ]),
      )
      .execute();

    return recoveredRun;
  }

  /**
   * Phase 1b: recover job state from the dispatch_queue and add it to the
   * run's in-memory map. Returns the freshly-inserted job entry.
   */
  private async recoverJobFromDispatchQueue(
    run: RunState,
    runId: string,
    jobId: string,
  ): Promise<RunState['jobs'] extends Map<string, infer V> ? V : never> {
    // Non-clobbering: if the entry already exists (e.g. a concurrent
    // addJobsToRun synthetic→real swap created the real job, possibly carrying a
    // terminal status preserved from the DB), reuse it. Overwriting it with a
    // fresh `pending` object would orphan the object onJobStatus is about to
    // mutate, dropping the status write and wedging the run in `running`. The
    // per-run lock already prevents the interleave, but reusing the existing
    // entry removes the orphaned-object footgun outright.
    const existing = run.jobs.get(jobId);
    if (existing) {
      return existing;
    }

    const queueEntry = await this.db
      .selectFrom('dispatch_queue')
      .select(['job_name'])
      .where('id', '=', jobId)
      .executeTakeFirst();

    const jobName = queueEntry?.job_name ?? jobId;
    run.jobs.set(jobId, { name: jobName, status: ExecutionJobStatus.enum.pending } as any);
    const job = run.jobs.get(jobId)!;

    logger.info('Recovered in-memory job state from dispatch_queue', {
      runId,
      jobId,
      jobName,
    });

    return job;
  }

  /**
   * Phase 2: build the upsert payload for execution_jobs and execute it.
   * Returns the per-job log byte total when the job reached a terminal state
   * (used downstream by the run-completion phase to populate run.log_bytes).
   */
  private async persistJobStatusUpdate(opts: {
    runId: string;
    jobId: string;
    state: string;
    timestamp: number;
    agentId: string | undefined;
    data: Record<string, unknown> | undefined;
    run: RunState | undefined;
    job: ReturnType<RunState['jobs']['get']> | undefined;
    now: Date;
    isFirstRunning: boolean;
  }): Promise<number | undefined> {
    const { runId, jobId, state, timestamp, agentId, data, run, job, now, isFirstRunning } = opts;

    // DB: upsert job row (INSERT on conflict UPDATE).
    // Uses upsert instead of plain UPDATE to handle the case where the
    // execution_jobs row was never inserted (e.g. failRun was called before
    // addJobsToRun because no agents were available at dispatch time, but
    // the job was already queued and an agent later picked it up).
    const updateValues: Record<string, unknown> = {
      status: state,
    };

    if (state === ExecutionJobStatus.enum.running) {
      if (isFirstRunning) {
        updateValues.started_at = now;
      }
      updateValues.last_heartbeat_at = now;
    }

    if (agentId) {
      updateValues.agent_id = agentId;
    }

    let jobLogBytesTotal: number | undefined;
    if (TERMINAL_JOB_STATES.has(state)) {
      updateValues.completed_at = now;
      // Compute job duration from job start (not run start)
      if (job?.startedAt) {
        // Always write started_at alongside completed_at to handle race
        // conditions where the first running message's DB UPDATE missed the
        // row (e.g. row not yet inserted by onExecutionStarted).
        updateValues.started_at = new Date(job.startedAt);
        updateValues.duration_ms = timestamp - job.startedAt;
      }
      if (data?.error) {
        updateValues.error_message = String(data.error);
      }
      // Persist structured init-failure signal for synthetic rejected-* /
      // init-failed-* jobs that never started. Survives orchestrator restart
      // and feeds the dashboard logs view.
      if (data?.initFailure) {
        updateValues.init_failure = JSON.stringify(data.initFailure);
      }
      // Store plain outputs for cross-job transport and dashboard display
      if (data?.outputs) {
        updateValues.outputs = JSON.stringify(data.outputs);
      }
      // Persist per-job log byte total accumulated from terminal step.status
      // messages. Default to 0 if no steps reported (e.g. job failed before
      // any step executed, or older-agent dispatch with no logBytesStreamed
      // field) — keeps the column NOT NULL DEFAULT 0 invariant.
      jobLogBytesTotal = this.jobLogBytes.get(runId)?.get(jobId) ?? 0;
      updateValues.log_bytes = jobLogBytesTotal;
    }

    // Look up job_name for upsert INSERT values (needed when row doesn't exist)
    const jobName = job?.name ?? jobId;

    await this.db
      .insertInto('execution_jobs')
      .values({
        run_id: runId,
        job_id: jobId,
        job_name: jobName,
        // Denormalized — see migration 006. `run.routingKey` is populated
        // either from the original onExecutionStarted call or via the
        // DB-recovery branch above (which copies routing_key from
        // execution_runs).
        routing_key: run?.routingKey ?? null,
        ...updateValues,
      })
      .onConflict((oc) => oc.columns(['run_id', 'job_id']).doUpdateSet(updateValues))
      .execute();

    return jobLogBytesTotal;
  }

  /**
   * Phase 3a: transition run from pending -> running when the first job
   * starts executing.
   */
  private async maybeTransitionRunToRunning(
    run: RunState | undefined,
    runId: string,
    jobId: string,
    state: string,
  ): Promise<void> {
    if (
      state !== ExecutionJobStatus.enum.running ||
      run?.status !== ExecutionRunStatus.enum.pending
    ) {
      return;
    }

    await this.db
      .updateTable('execution_runs')
      .set({ status: ExecutionRunStatus.enum.running })
      .where('run_id', '=', runId)
      .where('status', '=', ExecutionRunStatus.enum.pending)
      .execute();

    run.status = ExecutionRunStatus.enum.running;
    logger.info('Run transitioned to running', { runId, jobId });

    this.onExecutionStatusChange?.(
      runId,
      ExecutionRunStatus.enum.running,
      {
        workflowName: run.workflowName,
        provider: run.provider,
        repoIdentifier: run.repoIdentifier,
        sha: run.sha,
        installationId: run.installationId,
        requestId: run.requestId,
        routingKey: run.routingKey,
        ref: run.ref,
        triggerEvent: run.triggerEvent,
        commitMessage: run.commitMessage,
        parentRunId: run.parentRunId,
        originalRunId: run.originalRunId,
        triggeredBy: run.triggeredBy,
      },
      run.jobs.size,
      run.startedAt,
    );
  }

  /**
   * Phase 3b: when an agent reports 'cancelling', transition the run-level
   * status too. 'cancelling' means "graceful cancel in progress, hooks
   * running" — the run should reflect this intermediate state.
   */
  private async maybeTransitionRunToCancelling(
    run: RunState | undefined,
    runId: string,
    state: string,
  ): Promise<void> {
    if (state !== ExecutionJobStatus.enum.cancelling || !run) return;

    // Check DB for actual run status to avoid races
    const runRow = await this.db
      .selectFrom('execution_runs')
      .select('status')
      .where('run_id', '=', runId)
      .executeTakeFirst();

    if (
      runRow?.status !== ExecutionRunStatus.enum.running &&
      runRow?.status !== ExecutionRunStatus.enum.pending
    ) {
      return;
    }

    await this.db
      .updateTable('execution_runs')
      .set({ status: ExecutionRunStatus.enum.cancelling })
      .where('run_id', '=', runId)
      .where('status', 'in', [ExecutionRunStatus.enum.running, ExecutionRunStatus.enum.pending])
      .execute();

    run.status = ExecutionRunStatus.enum.cancelling;
    logger.info('Run transitioned to cancelling', { runId });

    // Notify Platform/dashboard of run status change
    this.onExecutionStatusChange?.(
      runId,
      ExecutionRunStatus.enum.cancelling,
      {
        workflowName: run.workflowName,
        provider: run.provider,
        repoIdentifier: run.repoIdentifier,
        sha: run.sha,
        installationId: run.installationId,
        requestId: run.requestId,
        routingKey: run.routingKey,
        ref: run.ref,
        triggerEvent: run.triggerEvent,
        commitMessage: run.commitMessage,
        parentRunId: run.parentRunId,
        originalRunId: run.originalRunId,
        triggeredBy: run.triggeredBy,
      },
      run.jobs.size,
      run.startedAt,
    );
  }

  /**
   * Phase 4: emit run.event and orchestration log entries at job lifecycle
   * points (job started / agent assigned / job terminal).
   */
  private emitJobLifecycleEvents(
    runId: string,
    jobId: string,
    state: string,
    timestamp: number,
    agentId: string | undefined,
    job: ReturnType<RunState['jobs']['get']> | undefined,
  ): void {
    if (state === ExecutionJobStatus.enum.running && job) {
      // Agent assignment event (when agentId is provided with running status)
      if (agentId) {
        this.emitRunEvent(runId, 'orchestrator.agent.assigned', {
          jobId,
          metadata: { agentId, jobName: job.name },
        });
        this.writeOrchLog(runId, jobId, 'setup', `Agent ${agentId} assigned`);
      }
      // Job started event
      this.emitRunEvent(runId, 'orchestrator.job.started', {
        jobId,
        metadata: { agentId, jobName: job.name },
      });
      this.writeOrchLog(
        runId,
        jobId,
        'setup',
        `Job execution started on agent ${agentId ?? 'unknown'}`,
      );
    } else if (TERMINAL_JOB_STATES.has(state) && job) {
      const jobDuration = job.startedAt ? timestamp - job.startedAt : undefined;
      this.emitRunEvent(runId, 'orchestrator.job.completed', {
        jobId,
        durationMs: jobDuration,
        metadata: { status: state, agentId },
      });
      this.writeOrchLog(runId, jobId, 'teardown', `Job completed with status ${state}`);
    }
  }

  /**
   * Phase 5: fire the onJobStatusChange callback for Platform forwarding.
   */
  private fireJobStatusChangeCallback(opts: {
    runId: string;
    jobId: string;
    state: string;
    timestamp: number;
    isFirstRunning: boolean;
    job: ReturnType<RunState['jobs']['get']> | undefined;
    data: Record<string, unknown> | undefined;
    jobLogBytesTotal: number | undefined;
  }): void {
    const { runId, jobId, state, timestamp, isFirstRunning, job, data, jobLogBytesTotal } = opts;
    if (!job) return;

    const isTerminal = TERMINAL_JOB_STATES.has(state);
    const startedAtMs = isFirstRunning ? timestamp : isTerminal ? job.startedAt : undefined;
    const completedAtMs = isTerminal ? timestamp : undefined;
    // Use job start time (not run start) for correct job duration
    const duration = isTerminal && job.startedAt ? timestamp - job.startedAt : undefined;
    const errorMsg = isTerminal && data?.error ? String(data.error) : undefined;
    // Forward the structured init-failure signal alongside the human-readable
    // error string when the caller provided one (synthetic rejected-* /
    // init-failed-* jobs).
    const initFailure =
      isTerminal && data?.initFailure ? (data.initFailure as InitFailure) : undefined;
    this.onJobStatusChange?.(
      runId,
      jobId,
      job.name,
      state,
      timestamp,
      startedAtMs,
      completedAtMs,
      duration,
      errorMsg,
      job.agentId,
      job.runsOnLabels,
      // Forward per-job log byte total to Platform on terminal job state.
      // jobLogBytesTotal is set in the same TERMINAL_JOB_STATES branch above.
      jobLogBytesTotal,
      initFailure,
    );
  }

  /**
   * Phase 6: reconcile orphaned steps. If a job reaches terminal state but
   * some steps are still 'running' (because a step.complete IPC message was
   * lost), mark them as the job's terminal state. Without this safety net,
   * the dashboard shows "running" with an ever-growing duration for the lost
   * step.
   */
  private async reconcileOrphanedSteps(
    runId: string,
    jobId: string,
    state: string,
    now: Date,
  ): Promise<void> {
    try {
      const result = await this.db
        .updateTable('execution_steps')
        .set({
          status: state,
          completed_at: now,
        })
        .where('run_id', '=', runId)
        .where('job_id', '=', jobId)
        .where('status', '=', ExecutionStepStatus.enum.running)
        .executeTakeFirst();
      const numUpdated = Number(result?.numUpdatedRows ?? 0);
      if (numUpdated > 0) {
        logger.warn('Reconciled orphaned steps on job completion', {
          runId,
          jobId,
          numUpdated,
          jobState: state,
        });
      }
    } catch (e) {
      logger.error('Failed to reconcile orphaned steps', { runId, jobId, error: e });
    }
  }

  /**
   * Phase 7: drift report handling.
   * When an agent reports droppedJobs, transition those sibling jobs to
   * drift_dropped. drift_dropped is a terminal state, so the scheduler hook
   * (Phase 8) will propagate failures to any downstreams.
   */
  private async handleDriftDroppedJobs(runId: string, droppedJobs: string[]): Promise<void> {
    for (const droppedJobName of droppedJobs) {
      try {
        // Look up the actual job_id from execution_jobs by name — onJobStatus
        // expects a UUID jobId, not a job name string.
        const droppedJobRow = await this.db
          .selectFrom('execution_jobs')
          .select('job_id')
          .where('run_id', '=', runId)
          .where('job_name', '=', droppedJobName)
          .executeTakeFirst();

        if (droppedJobRow) {
          await this.onJobStatus(
            runId,
            droppedJobRow.job_id,
            ExecutionJobStatus.enum.drift_dropped,
            Date.now(),
            undefined,
            { error: 'determinism drift: job dropped by re-evaluation on executing agent' },
          );
        } else {
          logger.warn('Drift-dropped job not found in execution_jobs', {
            runId,
            droppedJobName,
          });
        }
      } catch (e) {
        logger.error('Failed to transition drift-dropped job', {
          runId,
          droppedJobName,
          error: e,
        });
      }
    }
  }

  /**
   * Phase 8: needs-aware scheduler hook.
   * When a job reaches terminal state, evaluate its downstreams for dispatch.
   * The DAG is acyclic (validated at compile time L1 and eval time L2),
   * so recursive skip propagation terminates naturally.
   */
  private async runSchedulerHook(
    runId: string,
    jobId: string,
    jobName: string,
    state: string,
  ): Promise<void> {
    try {
      const schedulerResults = await evaluateDownstreams(this.db, runId, jobName, state);

      for (const result of schedulerResults) {
        if (result.action === 'skip') {
          // Failure propagation: transition downstream to skipped.
          // Look up the actual job_id from execution_jobs by name — onJobStatus
          // expects a UUID jobId, not a job name string.
          const downstreamJobRow = await this.db
            .selectFrom('execution_jobs')
            .select('job_id')
            .where('run_id', '=', runId)
            .where('job_name', '=', result.jobName)
            .executeTakeFirst();

          if (downstreamJobRow) {
            await this.onJobStatus(
              runId,
              downstreamJobRow.job_id,
              ExecutionJobStatus.enum.skipped,
              Date.now(),
              undefined,
              { error: result.reason },
            );
          } else {
            logger.warn('Scheduler skip target not found in execution_jobs', {
              runId,
              jobName: result.jobName,
            });
          }
        } else if (result.action === 'dispatch') {
          // Fire the onJobReady callback (processor handles actual dispatch)
          if (this.onJobReadyCallback) {
            await this.onJobReadyCallback(runId, result.jobName);
          }
        }
      }
    } catch (e) {
      logger.error('Scheduler hook failed', { runId, jobId, error: e });
    }
  }

  /**
   * Rolling-wave hook: fires beside the needs-scheduler when a fan-out child of
   * a bounded wave (`maxParallel` set) reaches terminal. Reads the completed
   * child's row to recover the base + wave policy, asks {@link evaluateWave}
   * what to do, then performs it:
   *
   * - `release`: clear the next held sibling's `wave_gated` flag and fire the
   *   onJobReady callback (the existing ready→dispatch path).
   * - `skip-remaining`: mark every still-held sibling `skipped` (failFast).
   * - `noop`: nothing — a later terminal will free the next slot.
   */
  private async runWaveSchedulerHook(runId: string, jobId: string, state: string): Promise<void> {
    try {
      const row = await this.db
        .selectFrom('execution_jobs')
        .select(['base_job_name'])
        .where('run_id', '=', runId)
        .where('job_id', '=', jobId)
        .executeTakeFirst();
      // Only act for a fan-out child. evaluateWave reads the wave policy from
      // the base group and noops when this is not a bounded wave.
      if (!row?.base_job_name) return;

      const result = await evaluateWave(this.db, {
        runId,
        baseJobName: row.base_job_name,
        completedStatus: state,
      });

      if (result.action === 'release') {
        await this.db
          .updateTable('execution_jobs')
          .set({ wave_gated: false })
          .where('run_id', '=', runId)
          .where('job_name', '=', result.jobName)
          .execute();
        if (this.onJobReadyCallback) await this.onJobReadyCallback(runId, result.jobName);
        // The ready→dispatch path (dispatchReadyJob → addJobsToRun) replaces the
        // synthetic row with a fresh one that does NOT carry the fan-out columns,
        // so re-stamp base_job_name + the wave policy on the released child. Without
        // this, when THIS child later reaches terminal, runWaveSchedulerHook reads a
        // null base and never releases the next sibling — the wave stalls after one
        // release.
        await this.db
          .updateTable('execution_jobs')
          .set({
            base_job_name: result.baseJobName,
            wave_max_parallel: result.maxParallel,
            wave_fail_fast: result.failFast,
          })
          .where('run_id', '=', runId)
          .where('job_name', '=', result.jobName)
          .execute();
        logger.info('Rolling wave released next child', {
          runId,
          baseJobName: row.base_job_name,
          released: result.jobName,
        });
      } else if (result.action === 'skip-remaining') {
        logger.info('Rolling wave halting (failFast): skipping held remainder', {
          runId,
          baseJobName: row.base_job_name,
          skipped: result.jobNames,
        });
        for (const jobName of result.jobNames) {
          const heldRow = await this.db
            .selectFrom('execution_jobs')
            .select('job_id')
            .where('run_id', '=', runId)
            .where('job_name', '=', jobName)
            .executeTakeFirst();
          if (!heldRow) continue;
          // Clear the gate so the skipped row is no longer a held sibling, then
          // transition it to skipped (mirrors the needs-scheduler skip path).
          await this.db
            .updateTable('execution_jobs')
            .set({ wave_gated: false })
            .where('run_id', '=', runId)
            .where('job_id', '=', heldRow.job_id)
            .execute();
          await this.onJobStatus(
            runId,
            heldRow.job_id,
            ExecutionJobStatus.enum.skipped,
            Date.now(),
            undefined,
            { error: 'fan-out halted by failFast' },
          );
        }
      }
    } catch (e) {
      logger.error('Wave scheduler hook failed', { runId, jobId, error: e });
    }
  }

  /**
   * Phase 9: stuck-jobs invariant check ( Layer 3).
   * Before declaring a run complete, verify no stuck jobs exist. If any are
   * found, fail them via recursive onJobStatus calls and signal the caller to
   * stop (returns true) — the recursive calls will re-enter and re-check
   * completion with fresh state.
   */
  private async enforceSchedulerInvariantOrFail(runId: string): Promise<boolean> {
    try {
      const stuckJobs = await checkSchedulerInvariant(this.db, runId);
      if (stuckJobs.length === 0) return false;

      logger.error('Scheduler invariant violated: stuck jobs detected', {
        runId,
        stuckJobs,
      });
      for (const stuckJobName of stuckJobs) {
        const stuckJobRow = await this.db
          .selectFrom('execution_jobs')
          .select('job_id')
          .where('run_id', '=', runId)
          .where('job_name', '=', stuckJobName)
          .executeTakeFirst();

        if (stuckJobRow) {
          await this.onJobStatus(
            runId,
            stuckJobRow.job_id,
            ExecutionJobStatus.enum.failed,
            Date.now(),
            undefined,
            { error: 'scheduler invariant violated: no ready jobs but non-terminal needs' },
          );
        }
      }
      // Re-check completion after failing stuck jobs (the recursive calls above
      // will re-enter this block for each stuck job, but completion re-check
      // ensures we don't proceed with stale state)
      return true;
    } catch (e) {
      logger.error('Scheduler invariant check failed', { runId, error: e });
      return false;
    }
  }

  /**
   * Phase 10: finalize run completion. Computes overall status, writes the
   * execution_runs row, fires Platform-forwarding + workflow-complete +
   * observer callbacks, and schedules in-memory pruning.
   */
  private async finalizeRunCompletion(
    run: RunState,
    runId: string,
    timestamp: number,
    now: Date,
  ): Promise<void> {
    const overallStatus = this.computeRunStatus(run);
    run.completedAt = timestamp;

    // DB: update run row
    const startedAt = run.startedAt;
    const durationMs = timestamp - startedAt;

    // Compute failure reason from failed job names
    const failureReason =
      overallStatus === ExecutionRunStatus.enum.failed
        ? this.buildRunDescription(run, overallStatus)
        : undefined;
    if (failureReason) {
      run.failureReason = failureReason;
    }

    // Sum the per-job log byte totals into a per-run total, mirroring how
    // duration_ms aggregates from per-job durations. Default 0 if no
    // per-job entries (e.g. all-failed-before-step run with no telemetry).
    let runLogBytesTotal = 0;
    const perJob = this.jobLogBytes.get(runId);
    if (perJob) {
      for (const v of perJob.values()) runLogBytesTotal += v;
    }

    // failure_reason write policy:
    //  - success: clear any stale reason (e.g. "No agents available" from a
    //    premature failRun that was recovered when the agent started).
    //  - failed: write the computed reason.
    //  - cancelled / other non-terminal-to-terminal: preserve any reason
    //    already stamped by the cancel path (user cancel, or the distinct
    //    workflow_timeout reason from cancelRunWithReason). Omitting the
    //    column from the update leaves the stamped reason intact, so the
    //    dashboard can still label the run "timed out" rather than a generic
    //    cancel.
    const failureReasonUpdate: { failure_reason?: string | null } =
      overallStatus === ExecutionRunStatus.enum.success
        ? { failure_reason: null }
        : failureReason !== undefined
          ? { failure_reason: failureReason }
          : {};

    // Do not override a run that was already marked failed due to a build
    // failure — the build agent may still complete its job but the run's
    // terminal state should be preserved.
    await this.db
      .updateTable('execution_runs')
      .set({
        status: overallStatus,
        completed_at: now,
        duration_ms: durationMs,
        log_bytes: runLogBytesTotal,
        ...failureReasonUpdate,
      })
      .where('run_id', '=', runId)
      .where((eb) =>
        eb.or([
          eb('status', '!=', ExecutionRunStatus.enum.failed),
          eb('failure_reason', 'is', null),
          eb(sql`lower(failure_reason)`, 'not like', '%build%'),
        ]),
      )
      .execute();

    executionsTotal.add(1, { status: overallStatus });
    executionDurationSeconds.record(durationMs / 1000);

    logger.info('Execution completed', {
      runId,
      status: overallStatus,
      durationMs,
      logBytes: runLogBytesTotal,
    });

    // Fire callback with execution context and failure summary
    const description = this.buildRunDescription(run, overallStatus);
    this.onExecutionComplete?.(
      runId,
      overallStatus,
      {
        workflowName: run.workflowName,
        provider: run.provider,
        repoIdentifier: run.repoIdentifier,
        sha: run.sha,
        installationId: run.installationId,
        requestId: run.requestId,
        routingKey: run.routingKey,
      },
      description,
    );

    // Fire status change callback for Platform forwarding (terminal)
    this.onExecutionStatusChange?.(
      runId,
      overallStatus,
      {
        workflowName: run.workflowName,
        provider: run.provider,
        repoIdentifier: run.repoIdentifier,
        sha: run.sha,
        installationId: run.installationId,
        requestId: run.requestId,
        routingKey: run.routingKey,
        ref: run.ref,
        triggerEvent: run.triggerEvent,
        commitMessage: run.commitMessage,
        parentRunId: run.parentRunId,
        originalRunId: run.originalRunId,
        triggeredBy: run.triggeredBy,
      },
      run.jobs.size,
      startedAt,
      timestamp,
      durationMs,
      failureReason,
      runLogBytesTotal,
    );

    // Fire onWorkflowComplete callback with rich data from in-memory state
    const jobResults = Array.from(run.jobs.values()).map((j) => ({
      name: j.name,
      status: j.status,
    }));
    this.onWorkflowComplete?.({
      runId,
      workflowName: run.workflowName,
      status: overallStatus,
      duration: durationMs,
      jobResults,
      routingKey: run.routingKey,
      repo: run.repoIdentifier,
    });

    // Broadcast run completion to observers (test runs only)
    if (this.observerRegistry && this.testRunIds.has(runId)) {
      this.observerRegistry.broadcastComplete(runId, overallStatus, {
        totalDurationMs: durationMs,
        jobs: jobResults,
      });
    }

    // Schedule memory pruning
    setTimeout(() => {
      this.runs.delete(runId);
      this.testRunIds.delete(runId);
      this.jobLogBytes.delete(runId);
      this.onRunPruned?.(runId);
    }, PRUNE_DELAY_MS);
  }

  /**
   * Mark a run as failed when its build fails (timeout or error).
   *
   * Called by the processor when a build job was tracked early via
   * onExecutionStarted but the build subsequently fails. Without this,
   * the execution_runs row would stay in a non-terminal state.
   */
  async onBuildFailed(runId: string, initFailure?: InitFailure): Promise<void> {
    const now = new Date();

    const failureReason = initFailure?.message ?? 'Build job failed';

    // Update DB — cascade to execution_runs, execution_jobs, and dispatch_queue
    await this.db
      .updateTable('execution_runs')
      .set({
        status: ExecutionRunStatus.enum.failed,
        completed_at: now,
        failure_reason: failureReason,
        ...(initFailure && { init_failure: JSON.stringify(initFailure) }),
      })
      .where('run_id', '=', runId)
      .execute();

    // Cascade: mark pending/queued execution_jobs as failed
    await this.db
      .updateTable('execution_jobs')
      .set({
        status: ExecutionJobStatus.enum.failed,
        completed_at: now,
        error_message: failureReason,
      })
      .where('run_id', '=', runId)
      .where('status', 'in', [ExecutionJobStatus.enum.pending, ExecutionJobStatus.enum.queued])
      .execute();

    // Cascade: mark pending/recovering dispatch_queue entries as failed
    await this.jobQueue?.failByRunId(runId);

    // Clean up in-memory state
    const run = this.runs.get(runId);
    if (run) {
      const completedAt = now.getTime();
      this.onExecutionStatusChange?.(
        runId,
        ExecutionRunStatus.enum.failed,
        {
          workflowName: run.workflowName,
          provider: run.provider,
          repoIdentifier: run.repoIdentifier,
          sha: run.sha,
          routingKey: run.routingKey,
          ref: run.ref,
          triggerEvent: run.triggerEvent,
          commitMessage: run.commitMessage,
          parentRunId: run.parentRunId,
          originalRunId: run.originalRunId,
          triggeredBy: run.triggeredBy,
        },
        run.jobs.size,
        run.startedAt,
        completedAt,
        completedAt - run.startedAt,
        failureReason,
        undefined,
        initFailure,
      );
      this.runs.delete(runId);
      this.jobLogBytes.delete(runId);
    }

    logger.info('Execution marked failed due to build failure', { runId });
  }

  /**
   * Create a failed execution run when the build timed out before onExecutionStarted
   * had a chance to insert the row (buildJobTrackedEarly was false).
   *
   * Inserts a minimal execution_runs row with status='failed' directly so the E2E
   * test (and dashboard) can observe the failure instead of a missing run.
   */
  async onBuildFailedBeforeTracking(
    runId: string,
    workflowName: string,
    provider: string,
    repoIdentifier: string,
    ref: string,
    sha: string,
    deliveryId: string | null,
    providerContext: Record<string, unknown>,
    routingKey: string,
    triggerEvent?: string,
    commitMessage?: string,
    failureReason?: string,
    initFailure?: InitFailure,
  ): Promise<void> {
    const now = new Date();
    const reason = failureReason ?? 'Build job timed out before execution tracking started';

    await this.db
      .insertInto('execution_runs')
      .values({
        run_id: runId,
        routing_key: routingKey,
        workflow_name: workflowName,
        provider,
        repo_identifier: repoIdentifier,
        ref,
        sha,
        delivery_id: deliveryId,
        trigger_decision: null,
        provider_context: JSON.stringify(providerContext),
        started_at: now,
        completed_at: now,
        status: ExecutionRunStatus.enum.failed,
        failure_reason: reason,
        ...(initFailure && { init_failure: JSON.stringify(initFailure) }),
      })
      .execute();

    logger.info('Created failed execution run (build failed before tracking)', {
      runId,
      workflowName,
      reason,
    });
  }

  /**
   * Insert a `failed` execution_runs row directly for an init failure that
   * occurred BEFORE onExecutionStarted ran (so no in-memory state exists
   * and no jobs were dispatched). Also writes the structured init_failure
   * signal and fires onExecutionStatusChange so Platform's projection picks
   * it up via the normal forward path. Idempotent: if a row already exists
   * for this runId, the insert is a no-op (ON CONFLICT DO NOTHING).
   *
   * Closes the silent pre-run-failure gap — without this helper, secret /
   * install-secret / all-jobs-rejected early-exits in dispatch-matched-workflow
   * leave no trace on the dashboard.
   */
  async recordInitFailureRun(args: {
    runId: string;
    workflowName: string;
    provider: string;
    repoIdentifier: string;
    ref: string;
    sha: string;
    deliveryId: string | null;
    providerContext: Record<string, unknown>;
    routingKey: string;
    initFailure: InitFailure;
    triggerEvent?: string;
    commitMessage?: string;
  }): Promise<void> {
    const now = new Date();
    await this.db
      .insertInto('execution_runs')
      .values({
        run_id: args.runId,
        routing_key: args.routingKey,
        workflow_name: args.workflowName,
        provider: args.provider,
        repo_identifier: args.repoIdentifier,
        ref: args.ref,
        sha: args.sha,
        delivery_id: args.deliveryId,
        trigger_decision: null,
        provider_context: JSON.stringify(args.providerContext),
        started_at: now,
        completed_at: now,
        status: ExecutionRunStatus.enum.failed,
        failure_reason: args.initFailure.message,
        init_failure: JSON.stringify(args.initFailure),
      })
      .onConflict((oc) => oc.column('run_id').doNothing())
      .execute();

    executionsTotal.add(1, { status: ExecutionRunStatus.enum.failed });

    this.onExecutionStatusChange?.(
      args.runId,
      ExecutionRunStatus.enum.failed,
      {
        workflowName: args.workflowName,
        provider: args.provider,
        repoIdentifier: args.repoIdentifier,
        sha: args.sha,
        routingKey: args.routingKey,
        ref: args.ref,
        triggerEvent: args.triggerEvent,
        commitMessage: args.commitMessage,
      },
      0,
      now.getTime(),
      now.getTime(),
      0,
      args.initFailure.message,
      0,
      args.initFailure,
    );

    logger.info('Recorded init-failure execution run', {
      runId: args.runId,
      workflowName: args.workflowName,
      category: args.initFailure.category,
      scope: args.initFailure.scope,
    });
  }

  /**
   * Record a run paused at the workflow install gate (a `registries:` /
   * `installEnv:` protection rule returned hold / wait / queue). Writes an
   * `execution_runs` row in the `held` state — alive and resumable — so the
   * dashboard run list surfaces the paused workflow. No jobs are tracked: the
   * workflow-scoped held_runs row + pending workflow context (written by the
   * caller) keep the run from being counted complete. Idempotent on runId.
   */
  async recordRunHeld(args: {
    runId: string;
    workflowName: string;
    provider: string;
    repoIdentifier: string;
    ref: string;
    sha: string;
    deliveryId: string | null;
    providerContext: Record<string, unknown>;
    routingKey: string;
    environmentName?: string;
    reason: string;
    triggerEvent?: string;
    commitMessage?: string;
  }): Promise<void> {
    const now = new Date();
    await this.db
      .insertInto('execution_runs')
      .values({
        run_id: args.runId,
        routing_key: args.routingKey,
        workflow_name: args.workflowName,
        provider: args.provider,
        repo_identifier: args.repoIdentifier,
        ref: args.ref,
        sha: args.sha,
        delivery_id: args.deliveryId,
        trigger_decision: null,
        provider_context: JSON.stringify(args.providerContext),
        started_at: now,
        status: ExecutionRunStatus.enum.held,
        ...(args.environmentName && { environment: args.environmentName }),
      })
      .onConflict((oc) => oc.column('run_id').doNothing())
      .execute();

    this.onExecutionStatusChange?.(
      args.runId,
      ExecutionRunStatus.enum.held,
      {
        workflowName: args.workflowName,
        provider: args.provider,
        repoIdentifier: args.repoIdentifier,
        sha: args.sha,
        routingKey: args.routingKey,
        ref: args.ref,
        triggerEvent: args.triggerEvent,
        commitMessage: args.commitMessage,
      },
      0,
      now.getTime(),
    );

    logger.info('Recorded held execution run (workflow install gate)', {
      runId: args.runId,
      workflowName: args.workflowName,
      environment: args.environmentName,
      reason: args.reason,
    });
  }

  /**
   * Flip a `held` run back to `pending` so the resumed dispatch can proceed
   * into job dispatch. Returns true when a held row was found and updated.
   */
  async resumeHeldRun(runId: string): Promise<boolean> {
    const result = await this.db
      .updateTable('execution_runs')
      .set({ status: ExecutionRunStatus.enum.pending })
      .where('run_id', '=', runId)
      .where('status', '=', ExecutionRunStatus.enum.held)
      .executeTakeFirst();
    const updated = Number(result?.numUpdatedRows ?? 0n) > 0;
    if (updated) {
      logger.info('Resumed held execution run', { runId });
    }
    return updated;
  }

  /**
   * Cancel a held run (reviewer rejected the install gate). Flips the held row
   * to `cancelled` and fires the status-change forward so Platform projects it.
   */
  async cancelHeldRun(runId: string, reason: string): Promise<void> {
    const now = new Date();
    const row = await this.db
      .updateTable('execution_runs')
      .set({
        status: ExecutionRunStatus.enum.cancelled,
        completed_at: now,
        failure_reason: reason,
      })
      .where('run_id', '=', runId)
      .where('status', '=', ExecutionRunStatus.enum.held)
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      logger.warn('cancelHeldRun: no held run to cancel', { runId });
      return;
    }
    this.onExecutionStatusChange?.(
      runId,
      ExecutionRunStatus.enum.cancelled,
      {
        workflowName: row.workflow_name,
        provider: row.provider ?? '',
        repoIdentifier: row.repo_identifier ?? '',
        sha: row.sha ?? '',
        routingKey: row.routing_key ?? undefined,
        ref: row.ref ?? '',
      },
      0,
      row.started_at ? new Date(row.started_at).getTime() : now.getTime(),
      now.getTime(),
      0,
      reason,
    );
    logger.info('Cancelled held execution run (install gate rejected)', { runId, reason });
  }

  /**
   * Mark a run as failed immediately with a reason message.
   *
   * Used when no agents are available to dispatch any jobs (e.g. cron-triggered
   * runs on a cluster leader without matching local agents and no reachable peers).
   * Instead of leaving the run in 'running' for OrphanRecovery to catch after 5 min,
   * this fails it right away.
   */
  async failRun(runId: string, reason: string, initFailure?: InitFailure): Promise<void> {
    const now = new Date();

    const run = this.runs.get(runId);
    const durationMs = run ? now.getTime() - run.startedAt : 0;

    // Update DB — cascade to execution_runs, execution_jobs, and dispatch_queue
    await this.db
      .updateTable('execution_runs')
      .set({
        status: ExecutionRunStatus.enum.failed,
        completed_at: now,
        duration_ms: durationMs,
        failure_reason: reason,
        ...(initFailure && { init_failure: JSON.stringify(initFailure) }),
      })
      .where('run_id', '=', runId)
      .execute();

    // Cascade: mark pending/queued execution_jobs as failed
    await this.db
      .updateTable('execution_jobs')
      .set({
        status: ExecutionJobStatus.enum.failed,
        completed_at: now,
        error_message: reason,
      })
      .where('run_id', '=', runId)
      .where('status', 'in', [ExecutionJobStatus.enum.pending, ExecutionJobStatus.enum.queued])
      .execute();

    // Cascade: mark pending/recovering dispatch_queue entries as failed
    await this.jobQueue?.failByRunId(runId);

    executionsTotal.add(1, { status: ExecutionRunStatus.enum.failed });
    executionDurationSeconds.record(durationMs / 1000);

    // Clean up in-memory state and fire callbacks
    if (run) {
      const completedAt = now.getTime();
      this.onExecutionStatusChange?.(
        runId,
        ExecutionRunStatus.enum.failed,
        {
          workflowName: run.workflowName,
          provider: run.provider,
          repoIdentifier: run.repoIdentifier,
          sha: run.sha,
          routingKey: run.routingKey,
          ref: run.ref,
          triggerEvent: run.triggerEvent,
          commitMessage: run.commitMessage,
          parentRunId: run.parentRunId,
          originalRunId: run.originalRunId,
          triggeredBy: run.triggeredBy,
        },
        run.jobs.size,
        run.startedAt,
        completedAt,
        completedAt - run.startedAt,
        reason,
        undefined,
        initFailure,
      );
      this.runs.delete(runId);
      this.jobLogBytes.delete(runId);
    }

    logger.info('Execution marked failed', { runId, reason });
  }

  /**
   * Update step status within a job.
   *
   * Upserts execution_steps row with timing information. On 'running',
   * sets started_at. On terminal state, sets completed_at, duration_ms,
   * exit_code. Also constructs log_path and forwards to Platform.
   *
   * @param logBytesStreamed Raw byte total reported by the agent's
   *   LogStreamer at terminal step time. Accumulated into a per-(run, job)
   *   counter that lands in `execution_jobs.log_bytes` and
   *   `execution_runs.log_bytes` when the job and run reach terminal state,
   *   feeding the operator-side `kici_org_log_bytes` capacity-planning gauge
   *   on the Platform.
   */
  async onStepStatus(
    runId: string,
    jobId: string,
    stepIndex: number,
    stepName: string,
    state: string,
    timestamp: number,
    data?: Record<string, unknown>,
    logBytesStreamed?: number,
  ): Promise<void> {
    // Accumulate raw bytes for the (run, job) on terminal step state. Only
    // count once per step; the agent only sets logBytesStreamed on terminal
    // states. Defensive: accept undefined silently (e.g. older agents).
    if (
      logBytesStreamed !== undefined &&
      logBytesStreamed >= 0 &&
      (state === ExecutionStepStatus.enum.success ||
        state === ExecutionStepStatus.enum.failed ||
        state === ExecutionStepStatus.enum.skipped)
    ) {
      let perJob = this.jobLogBytes.get(runId);
      if (!perJob) {
        perJob = new Map<string, number>();
        this.jobLogBytes.set(runId, perJob);
      }
      perJob.set(jobId, (perJob.get(jobId) ?? 0) + logBytesStreamed);
    }
    const jobName = this.getJobName(runId, jobId) ?? jobId;
    const logPath = `executions/${runId}/job-${jobName}/step-${stepIndex}.log`;
    const now = new Date(timestamp);

    // Build values for upsert (single object for both insert and conflict update)
    const values: Record<string, unknown> = {
      run_id: runId,
      job_id: jobId,
      step_index: stepIndex,
      step_name: stepName,
      status: state,
      log_path: logPath,
      // Denormalized — see migration 006. The in-memory run state is
      // populated by onExecutionStarted / DB-recovery before steps fire.
      routing_key: this.runs.get(runId)?.routingKey ?? null,
    };

    // Store step_type if provided (e.g. 'hook:onCancel', 'hook:cleanup')
    if (data?.stepType && typeof data.stepType === 'string') {
      values.step_type = data.stepType;
    }

    if (state === ExecutionStepStatus.enum.running) {
      values.started_at = now;
    }

    if (TERMINAL_JOB_STATES.has(state)) {
      values.completed_at = now;
      if (data?.exitCode !== undefined) {
        values.exit_code = Number(data.exitCode);
      }
      if (data?.durationMs !== undefined) {
        values.duration_ms = Number(data.durationMs);
      }
      if (data?.error) {
        values.error_message = String(data.error);
      }
    }

    // Always persist secretsAccessed when present in data (even empty array)
    if (data?.secretsAccessed !== undefined) {
      values.secrets_accessed = JSON.stringify(data.secretsAccessed);
    }

    // Idempotent check-mode per-step fields (forwarded from the agent's
    // step.complete IPC via step.status.data).
    if (data?.checkOutcome !== undefined) {
      values.check_outcome = String(data.checkOutcome);
      // Track run-level drift for check-fail-on-drift terminal status.
      if (data.checkOutcome === CheckStepOutcome.enum['dry-run']) {
        const run = this.runs.get(runId);
        if (run) run.driftDetected = true;
      }
    }
    if (data?.driftSummary !== undefined) {
      values.drift_summary = String(data.driftSummary);
    }
    if (data?.drift !== undefined) {
      values.drift = JSON.stringify(data.drift);
    }

    await this.db
      .insertInto('execution_steps')
      .values(values as any)
      .onConflict((oc) => oc.columns(['run_id', 'job_id', 'step_index']).doUpdateSet(values as any))
      .execute();

    // Forward step status to Platform
    const run = this.runs.get(runId);
    this.onStepStatusForward?.(
      runId,
      jobId,
      jobName,
      stepIndex,
      stepName,
      state,
      timestamp,
      data,
      run?.requestId,
    );

    // Broadcast step status to observers (test runs only)
    if (this.observerRegistry && this.testRunIds.has(runId)) {
      const durationMs = data?.durationMs !== undefined ? Number(data.durationMs) : undefined;
      this.observerRegistry.broadcastStep(runId, jobId, jobName, stepName, state, durationMs);
    }
  }

  /**
   * Check if all tracked jobs in a run have reached terminal state.
   */
  isRunComplete(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    for (const job of run.jobs.values()) {
      if (!TERMINAL_JOB_STATES.has(job.status)) {
        return false;
      }
    }
    return run.jobs.size > 0;
  }

  /**
   * Get the current overall status of a run.
   */
  getRunStatus(
    runId: string,
  ): Extract<ExecutionRunStatus, 'running' | 'success' | 'failed' | 'cancelled'> {
    const run = this.runs.get(runId);
    if (!run) return ExecutionRunStatus.enum.running;
    if (!this.isRunComplete(runId)) return ExecutionRunStatus.enum.running;
    return this.computeRunStatus(run);
  }

  /**
   * Look up a job name from in-memory state.
   * Used by LogWriter to construct log paths.
   */
  getJobName(runId: string, jobId: string): string | undefined {
    return this.runs.get(runId)?.jobs.get(jobId)?.name;
  }

  /**
   * Get execution context for a run from in-memory state.
   * Used by commit status reporting to access provider/repo/sha info.
   */
  getExecutionContext(runId: string): ExecutionContext | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    return {
      workflowName: run.workflowName,
      provider: run.provider,
      repoIdentifier: run.repoIdentifier,
      sha: run.sha,
      installationId: run.installationId,
      routingKey: run.routingKey,
      concurrency: run.concurrency,
    };
  }

  /**
   * Update the heartbeat timestamp for a running job.
   *
   * Uses optimistic WHERE status='running' so completed jobs are not updated.
   * Called when the agent sends a job.heartbeat message.
   */
  async updateJobHeartbeat(runId: string, jobId: string): Promise<void> {
    await this.db
      .updateTable('execution_jobs')
      .set({ last_heartbeat_at: new Date() })
      .where('run_id', '=', runId)
      .where('job_id', '=', jobId)
      .where('status', '=', ExecutionJobStatus.enum.running)
      .execute();
  }

  /**
   * Get the count of active (non-completed) runs in memory.
   */
  getActiveRunCount(): number {
    let count = 0;
    for (const run of this.runs.values()) {
      if (!run.completedAt) count++;
    }
    return count;
  }

  /**
   * Get a summary of all active runs for the cluster health API.
   * Returns run ID, workflow name, status, and job routing counts.
   */
  getActiveRuns(): Array<{
    runId: string;
    workflowName: string;
    status: string;
    jobs: {
      total: number;
      completed: number;
      failed: number;
      running: number;
    };
  }> {
    const result: Array<{
      runId: string;
      workflowName: string;
      status: string;
      jobs: { total: number; completed: number; failed: number; running: number };
    }> = [];

    for (const [runId, run] of this.runs) {
      if (run.completedAt) continue; // Skip completed runs

      let completed = 0;
      let failed = 0;
      let running = 0;

      for (const job of run.jobs.values()) {
        if (
          job.status === ExecutionJobStatus.enum.success ||
          job.status === ExecutionJobStatus.enum.skipped
        ) {
          completed++;
        } else if (
          job.status === ExecutionJobStatus.enum.failed ||
          job.status === ExecutionJobStatus.enum.cancelled ||
          job.status === ExecutionJobStatus.enum.timed_out_stale
        ) {
          failed++;
        } else {
          running++;
        }
      }

      result.push({
        runId,
        workflowName: run.workflowName,
        status: this.isRunComplete(runId) ? this.computeRunStatus(run) : run.status,
        jobs: {
          total: run.jobs.size,
          completed,
          failed,
          running,
        },
      });
    }

    return result;
  }

  /**
   * Get replay data for all in-memory runs (both active and recently completed).
   * Used to send a state.replay message to Platform on reconnection so the Platform
   * can reconcile its execution_runs and execution_jobs projection tables.
   */
  getReplayData(): Array<{
    runId: string;
    workflowName: string;
    status: ExecutionRunStatus;
    routingKey?: string;
    repoIdentifier?: string;
    sha?: string;
    ref?: string;
    triggerEvent?: string;
    commitMessage?: string;
    parentRunId?: string | null;
    originalRunId?: string | null;
    triggeredBy?: string | null;
    failureReason?: string;
    jobCount: number;
    startedAt: number;
    completedAt?: number;
    durationMs?: number;
    jobs: Array<{
      jobId: string;
      jobName: string;
      status: string;
      startedAt?: number;
      completedAt?: number;
      runsOnLabels?: string[];
    }>;
  }> {
    const result: Array<{
      runId: string;
      workflowName: string;
      status: ExecutionRunStatus;
      routingKey?: string;
      repoIdentifier?: string;
      sha?: string;
      ref?: string;
      triggerEvent?: string;
      commitMessage?: string;
      parentRunId?: string | null;
      originalRunId?: string | null;
      triggeredBy?: string | null;
      failureReason?: string;
      jobCount: number;
      startedAt: number;
      completedAt?: number;
      durationMs?: number;
      jobs: Array<{
        jobId: string;
        jobName: string;
        status: string;
        startedAt?: number;
        completedAt?: number;
        agentId?: string;
        runsOnLabels?: string[];
      }>;
    }> = [];

    for (const [runId, run] of this.runs) {
      const isComplete = this.isRunComplete(runId);
      const status = isComplete ? this.computeRunStatus(run) : run.status;
      const durationMs = run.completedAt ? run.completedAt - run.startedAt : undefined;

      const jobs: Array<{
        jobId: string;
        jobName: string;
        status: string;
        startedAt?: number;
        completedAt?: number;
        agentId?: string;
        runsOnLabels?: string[];
      }> = [];

      for (const [jobId, job] of run.jobs) {
        jobs.push({
          jobId,
          jobName: job.name,
          status: job.status,
          ...(job.startedAt !== undefined && { startedAt: job.startedAt }),
          ...(job.agentId && { agentId: job.agentId }),
          ...(job.runsOnLabels?.length && { runsOnLabels: job.runsOnLabels }),
        });
      }

      result.push({
        runId,
        workflowName: run.workflowName,
        status,
        routingKey: run.routingKey,
        repoIdentifier: run.repoIdentifier,
        sha: run.sha,
        ref: run.ref,
        triggerEvent: run.triggerEvent,
        commitMessage: run.commitMessage,
        parentRunId: run.parentRunId,
        originalRunId: run.originalRunId,
        triggeredBy: run.triggeredBy,
        ...(run.failureReason && { failureReason: run.failureReason }),
        jobCount: run.jobs.size,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        durationMs,
        jobs,
      });
    }

    return result;
  }

  /**
   * Replay data merged with terminal runs read from the orchestrator's local DB.
   *
   * `getReplayData()` only sees runs still in memory. After an orchestrator
   * crash/restart, in-memory state is empty until new webhooks arrive — but
   * any run that completed before the crash still lives in `execution_runs`
   * on disk. Without re-emitting those, Platform's mirror table (and the
   * `kici_org_executions_count` operator-aggregate gauge) silently undercounts.
   *
   * This wrapper fills that gap: it returns the in-memory replay items first,
   * then unions in any terminal-state runs from the local DB completed within
   * `windowHours` (default 24h) that aren't already covered. Order is preserved
   * for in-memory entries (callers may rely on that for active-run metadata);
   * DB-backed entries are appended in `completed_at ASC` order.
   *
   * Idempotent: Platform's `state.replay` handler upserts on `run_id`, so
   * re-emitting an already-mirrored run is a no-op for billing and dashboard
   * state alike.
   */
  async getReplayDataWithDb(
    windowHours = 24,
  ): Promise<ReturnType<ExecutionTracker['getReplayData']>> {
    const inMemory = this.getReplayData();
    const seen = new Set(inMemory.map((r) => r.runId));

    let dbRuns: Array<{
      run_id: string;
      workflow_name: string;
      status: string;
      routing_key: string | null;
      repo_identifier: string;
      sha: string;
      ref: string;
      started_at: Date;
      completed_at: Date | null;
      duration_ms: number | null;
      parent_run_id: string | null;
      original_run_id: string | null;
      triggered_by: string | null;
      failure_reason: string | null;
    }> = [];

    try {
      dbRuns = (await this.db
        .selectFrom('execution_runs')
        .select([
          'run_id',
          'workflow_name',
          'status',
          'routing_key',
          'repo_identifier',
          'sha',
          'ref',
          'started_at',
          'completed_at',
          'duration_ms',
          'parent_run_id',
          'original_run_id',
          'triggered_by',
          'failure_reason',
        ])
        .where('status', 'in', [
          ExecutionRunStatus.enum.success,
          ExecutionRunStatus.enum.failed,
          ExecutionRunStatus.enum.cancelled,
        ])
        .where('completed_at', '>', sql<Date>`now() - make_interval(hours => ${windowHours})`)
        .orderBy('completed_at', 'asc')
        .execute()) as typeof dbRuns;
    } catch (err) {
      logger.warn('Failed to load DB-backed terminal runs for replay', {
        error: toErrorMessage(err),
      });
      return inMemory;
    }

    if (dbRuns.length === 0) return inMemory;

    const dbJobsByRun = new Map<
      string,
      Array<{ jobId: string; jobName: string; status: string }>
    >();
    try {
      const jobIds = dbRuns.filter((r) => !seen.has(r.run_id)).map((r) => r.run_id);
      if (jobIds.length > 0) {
        const dbJobs = await this.db
          .selectFrom('execution_jobs')
          .select(['run_id', 'job_id', 'job_name', 'status'])
          .where('run_id', 'in', jobIds)
          .execute();
        for (const j of dbJobs) {
          const arr = dbJobsByRun.get(j.run_id) ?? [];
          arr.push({ jobId: j.job_id, jobName: j.job_name, status: j.status });
          dbJobsByRun.set(j.run_id, arr);
        }
      }
    } catch (err) {
      logger.warn('Failed to load DB-backed jobs for replay', {
        error: toErrorMessage(err),
      });
    }

    const merged = [...inMemory];
    let appended = 0;
    for (const r of dbRuns) {
      if (seen.has(r.run_id)) continue;
      const jobs = dbJobsByRun.get(r.run_id) ?? [];
      merged.push({
        runId: r.run_id,
        workflowName: r.workflow_name,
        status: r.status as ExecutionRunStatus,
        ...(r.routing_key && { routingKey: r.routing_key }),
        repoIdentifier: r.repo_identifier,
        sha: r.sha,
        ref: r.ref,
        parentRunId: r.parent_run_id,
        originalRunId: r.original_run_id,
        triggeredBy: r.triggered_by,
        ...(r.failure_reason && { failureReason: r.failure_reason }),
        jobCount: jobs.length,
        startedAt: r.started_at.getTime(),
        ...(r.completed_at && { completedAt: r.completed_at.getTime() }),
        ...(r.duration_ms !== null && { durationMs: r.duration_ms }),
        jobs,
      });
      appended++;
    }

    if (appended > 0) {
      logger.info('Merged DB-backed terminal runs into replay payload', {
        inMemoryCount: inMemory.length,
        dbAppendedCount: appended,
        windowHours,
      });
    }

    return merged;
  }

  /**
   * Update a job's in-memory status without touching the DB.
   * Used by StaleRunDetector which does direct DB updates and only needs
   * the in-memory state kept in sync for run completion detection.
   */
  updateInMemoryJob(runId: string, jobId: string, status: string): void {
    const job = this.runs.get(runId)?.jobs.get(jobId);
    if (job) job.status = status;
  }

  /**
   * Forward a terminal job status to Platform via the onJobStatusChange callback.
   * Used by StaleRunDetector and OrphanRecovery which update the DB directly
   * but need to notify Platform so its execution_jobs projection stays in sync.
   */
  forwardJobTerminalStatus(
    runId: string,
    jobId: string,
    jobName: string,
    status: string,
    errorMessage?: string,
  ): void {
    const now = Date.now();
    const run = this.runs.get(runId);
    const job = run?.jobs.get(jobId);
    const startedAt = job?.startedAt;
    const durationMs = startedAt ? now - startedAt : undefined;
    this.onJobStatusChange?.(
      runId,
      jobId,
      jobName,
      status,
      now,
      startedAt,
      now,
      durationMs,
      errorMessage,
      job?.agentId,
      job?.runsOnLabels,
    );
  }

  /**
   * Emit a run.event message via the onRunEventEmit callback.
   * Public wrapper for use by StaleRunDetector and OrphanRecovery.
   */
  emitInfraEvent(
    runId: string,
    eventType: string,
    opts?: {
      jobId?: string;
      metadata?: Record<string, unknown>;
      durationMs?: number;
    },
  ): void {
    this.emitRunEvent(runId, eventType, opts);
  }

  /**
   * Cancel all non-terminal steps for a job.
   *
   * When a job is terminated by infrastructure (stale detection, orphan recovery,
   * recovery timeout), any in-progress steps remain with status='running' in the DB.
   * This method marks them as 'cancelled' so the dashboard doesn't show stale
   * running indicators for steps that are no longer executing.
   */
  async cancelStepsForJob(runId: string, jobId: string, reason: string): Promise<void> {
    // Find non-terminal steps for this job
    const steps = await this.db
      .selectFrom('execution_steps')
      .select(['step_index', 'step_name', 'status'])
      .where('run_id', '=', runId)
      .where('job_id', '=', jobId)
      .where('status', 'not in', [
        ExecutionStepStatus.enum.success,
        ExecutionStepStatus.enum.failed,
        ExecutionJobStatus.enum.cancelled,
        ExecutionStepStatus.enum.skipped,
      ])
      .execute();

    if (steps.length === 0) return;

    const now = new Date();

    // Bulk update all non-terminal steps to cancelled
    await this.db
      .updateTable('execution_steps')
      .set({
        status: ExecutionJobStatus.enum.cancelled,
        completed_at: now,
        error_message: reason,
      })
      .where('run_id', '=', runId)
      .where('job_id', '=', jobId)
      .where('status', 'not in', [
        ExecutionStepStatus.enum.success,
        ExecutionStepStatus.enum.failed,
        ExecutionJobStatus.enum.cancelled,
        ExecutionStepStatus.enum.skipped,
      ])
      .execute();

    // Forward each step's status update to Platform
    const jobName = this.getJobName(runId, jobId) ?? jobId;
    const run = this.runs.get(runId);
    for (const step of steps) {
      this.onStepStatusForward?.(
        runId,
        jobId,
        jobName,
        step.step_index,
        step.step_name,
        ExecutionJobStatus.enum.cancelled,
        now.getTime(),
        { error: reason },
        run?.requestId,
      );
    }

    logger.info('Cancelled in-progress steps for terminated job', {
      runId,
      jobId,
      stepsAffected: steps.length,
    });
  }

  /**
   * Check if all jobs for a run are terminal, and if so, complete the run.
   * Works with in-memory state (normal operation) or falls back to DB query
   * (crash recovery / pruned runs). Called by StaleRunDetector after marking
   * stale jobs.
   */
  async completeRunIfAllJobsTerminal(runId: string): Promise<void> {
    // Path A: in-memory state available (normal operation)
    const memRun = this.runs.get(runId);
    if (memRun) {
      if (this.isRunComplete(runId)) {
        await this.completeRunFromMemoryState(memRun, runId);
      }
      return;
    }

    // Path B: DB-fallback (crash recovery -- in-memory state empty)
    await this.completeRunFromDbFallback(runId);
  }

  /**
   * Path A helper: complete a run using in-memory state. Called by the
   * stale detector when memRun is still tracked locally — writes the
   * execution_runs terminal row, fires Platform-forwarding +
   * workflow-complete callbacks, and schedules in-memory pruning.
   */
  private async completeRunFromMemoryState(memRun: RunState, runId: string): Promise<void> {
    const overallStatus = this.computeRunStatus(memRun);
    memRun.completedAt = Date.now();
    const durationMs = memRun.completedAt - memRun.startedAt;

    const staleFailureReason =
      overallStatus === ExecutionRunStatus.enum.failed
        ? 'Run completed via stale detection (no heartbeat received)'
        : undefined;

    await this.db
      .updateTable('execution_runs')
      .set({
        status: overallStatus,
        completed_at: new Date(),
        duration_ms: durationMs,
      })
      .where('run_id', '=', runId)
      .where('status', 'in', [
        ExecutionRunStatus.enum.pending,
        ExecutionRunStatus.enum.running,
        ExecutionRunStatus.enum.cancelling,
      ])
      .execute();

    // Only stamp the generic stale reason if nothing more specific
    // (e.g. a scaler provisioning error or an agent step-failure) was
    // recorded. A clobber-guarded UPDATE keeps the specific cause visible in
    // `kici status` and the dashboard banner.
    if (staleFailureReason) {
      await this.db
        .updateTable('execution_runs')
        .set({ failure_reason: staleFailureReason })
        .where('run_id', '=', runId)
        .where('failure_reason', 'is', null)
        .execute();
    }

    executionsTotal.add(1, { status: overallStatus });
    executionDurationSeconds.record(durationMs / 1000);

    logger.info('Execution completed (stale detector)', {
      runId,
      status: overallStatus,
      durationMs,
    });

    const description = this.buildRunDescription(memRun, overallStatus);
    this.onExecutionComplete?.(
      runId,
      overallStatus,
      {
        workflowName: memRun.workflowName,
        provider: memRun.provider,
        repoIdentifier: memRun.repoIdentifier,
        sha: memRun.sha,
        installationId: memRun.installationId,
        requestId: memRun.requestId,
        routingKey: memRun.routingKey,
      },
      description,
    );

    // Fire status change callback for Platform forwarding (stale detector terminal)
    this.onExecutionStatusChange?.(
      runId,
      overallStatus,
      {
        workflowName: memRun.workflowName,
        provider: memRun.provider,
        repoIdentifier: memRun.repoIdentifier,
        sha: memRun.sha,
        installationId: memRun.installationId,
        requestId: memRun.requestId,
        routingKey: memRun.routingKey,
        ref: memRun.ref,
        triggerEvent: memRun.triggerEvent,
        commitMessage: memRun.commitMessage,
        parentRunId: memRun.parentRunId,
        originalRunId: memRun.originalRunId,
        triggeredBy: memRun.triggeredBy,
      },
      memRun.jobs.size,
      memRun.startedAt,
      memRun.completedAt,
      durationMs,
      staleFailureReason,
    );

    // Fire onWorkflowComplete callback (stale detector path)
    const staleJobResults = Array.from(memRun.jobs.values()).map((j) => ({
      name: j.name,
      status: j.status,
    }));
    this.onWorkflowComplete?.({
      runId,
      workflowName: memRun.workflowName,
      status: overallStatus,
      duration: durationMs,
      jobResults: staleJobResults,
      routingKey: memRun.routingKey,
      repo: memRun.repoIdentifier,
    });

    // Schedule memory pruning
    setTimeout(() => {
      this.runs.delete(runId);
      this.jobLogBytes.delete(runId);
      this.onRunPruned?.(runId);
    }, PRUNE_DELAY_MS);
  }

  /**
   * Path B helper: complete a run using DB rows only (crash recovery /
   * pruned runs). Loads jobs + run row from execution_jobs/execution_runs,
   * checks the all-terminal predicate + run-state guard, then writes the
   * terminal row and fires Platform-forwarding callbacks.
   */
  private async completeRunFromDbFallback(runId: string): Promise<void> {
    const jobs = await this.db
      .selectFrom('execution_jobs')
      .select(['status', 'job_name'])
      .where('run_id', '=', runId)
      .execute();

    const allTerminal = jobs.length > 0 && jobs.every((j) => TERMINAL_JOB_STATES.has(j.status));
    if (!allTerminal) return;

    // Compute overall status from DB rows
    const hasFailed = jobs.some(
      (j) =>
        j.status === ExecutionJobStatus.enum.failed ||
        j.status === ExecutionJobStatus.enum.timed_out_stale,
    );
    const hasCancelled = jobs.some((j) => j.status === ExecutionJobStatus.enum.cancelled);
    const overallStatus: Extract<ExecutionRunStatus, 'success' | 'failed' | 'cancelled'> = hasFailed
      ? ExecutionRunStatus.enum.failed
      : hasCancelled
        ? ExecutionRunStatus.enum.cancelled
        : ExecutionRunStatus.enum.success;

    // Verify run still running (optimistic concurrency)
    const dbRun = await this.db
      .selectFrom('execution_runs')
      .select([
        'status',
        'workflow_name',
        'provider',
        'repo_identifier',
        'sha',
        'ref',
        'routing_key',
        'provider_context',
        'started_at',
        'parent_run_id',
        'original_run_id',
        'triggered_by',
      ])
      .where('run_id', '=', runId)
      .executeTakeFirst();

    if (
      !dbRun ||
      (dbRun.status !== ExecutionRunStatus.enum.pending &&
        dbRun.status !== ExecutionRunStatus.enum.running &&
        dbRun.status !== ExecutionRunStatus.enum.cancelling)
    )
      return;

    const now = new Date();
    const durationMs = now.getTime() - new Date(dbRun.started_at).getTime();

    const orphanFailureReason =
      overallStatus === ExecutionRunStatus.enum.failed
        ? 'Run recovered from orphaned state (DB-fallback completion)'
        : undefined;

    await this.db
      .updateTable('execution_runs')
      .set({
        status: overallStatus,
        completed_at: now,
        duration_ms: durationMs,
      })
      .where('run_id', '=', runId)
      .where('status', 'in', [
        ExecutionRunStatus.enum.pending,
        ExecutionRunStatus.enum.running,
        ExecutionRunStatus.enum.cancelling,
      ])
      .execute();

    // Only stamp the generic orphan reason if nothing more specific
    // (e.g. a scaler provisioning error or an agent step-failure) was
    // recorded. A clobber-guarded UPDATE keeps the specific cause visible in
    // `kici status` and the dashboard banner.
    if (orphanFailureReason) {
      await this.db
        .updateTable('execution_runs')
        .set({ failure_reason: orphanFailureReason })
        .where('run_id', '=', runId)
        .where('failure_reason', 'is', null)
        .execute();
    }

    executionsTotal.add(1, { status: overallStatus });
    executionDurationSeconds.record(durationMs / 1000);

    logger.info('Execution completed (stale detector, DB-fallback)', {
      runId,
      status: overallStatus,
      durationMs,
    });

    // Fire callback (Platform forwarding, workflow check run update)
    const providerCtx =
      typeof dbRun.provider_context === 'string'
        ? JSON.parse(dbRun.provider_context)
        : (dbRun.provider_context ?? {});
    const installationId =
      typeof providerCtx.installationId === 'number' ? providerCtx.installationId : undefined;

    // Build description from DB job rows
    const failedJobNames = jobs
      .filter(
        (j) =>
          j.status === ExecutionJobStatus.enum.failed ||
          j.status === ExecutionJobStatus.enum.timed_out_stale,
      )
      .map((j) => j.job_name);
    const description =
      overallStatus !== ExecutionRunStatus.enum.success && failedJobNames.length > 0
        ? `Failed jobs: ${failedJobNames.join(', ')}`
        : undefined;

    this.onExecutionComplete?.(
      runId,
      overallStatus,
      {
        workflowName: dbRun.workflow_name,
        provider: dbRun.provider,
        repoIdentifier: dbRun.repo_identifier,
        sha: dbRun.sha,
        installationId,
        routingKey: dbRun.routing_key ?? undefined,
      },
      description,
    );

    // Fire status change callback for Platform forwarding (DB-fallback terminal)
    this.onExecutionStatusChange?.(
      runId,
      overallStatus,
      {
        workflowName: dbRun.workflow_name,
        provider: dbRun.provider,
        repoIdentifier: dbRun.repo_identifier,
        sha: dbRun.sha,
        installationId,
        routingKey: dbRun.routing_key ?? undefined,
        ref: dbRun.ref,
        parentRunId: dbRun.parent_run_id ?? undefined,
        originalRunId: dbRun.original_run_id ?? undefined,
        triggeredBy: dbRun.triggered_by ?? undefined,
      },
      jobs.length,
      new Date(dbRun.started_at).getTime(),
      now.getTime(),
      durationMs,
      orphanFailureReason,
    );
  }

  /**
   * Emit a run.event message to Platform via the onRunEventEmit callback.
   * Called at orchestrator lifecycle points for infrastructure event tracking.
   */
  private emitRunEvent(
    runId: string,
    eventType: string,
    opts?: {
      jobId?: string;
      metadata?: Record<string, unknown>;
      durationMs?: number;
    },
  ): void {
    // Skip emit until orgId is bootstrapped — we keep the gate even though
    // we no longer ship orgId on the wire (the field was dropped to enforce
    // that tenant attribution comes only from authState.orgId on the
    // Platform side; see docs/architecture/security/ws-tenant-isolation.md).
    // Emitting before bootstrap would publish events whose authState mapping
    // could be ambiguous on a non-platform-bound orchestrator.
    if (!this.onRunEventEmit || !this.orgId) return;
    this.onRunEventEmit({
      runId,
      eventType,
      timestampMs: Date.now(),
      sourceService: 'orchestrator',
      jobId: opts?.jobId ?? null,
      metadata: opts?.metadata,
      durationMs: opts?.durationMs ?? null,
    });
  }

  /**
   * Emit a scaler lifecycle event for a job.
   * Stores the event in the event_log table via the existing run.event pipeline
   * and writes a log line to the provisioning JSONL file.
   *
   * @param runId - The run this event belongs to
   * @param jobId - The job this event belongs to
   * @param event - The scaler event with type, detail, and timestamp
   */
  emitScalerEvent(
    runId: string,
    jobId: string,
    event: { agentId: string; eventType: ScalerEventType; detail: string; timestampMs: number },
  ): void {
    // 1. Emit as a run.event for timeline rendering
    this.emitRunEvent(runId, event.eventType, {
      jobId,
      metadata: {
        agentId: event.agentId,
        detail: event.detail,
        category: 'scaler',
      },
    });

    // 2. Write to provisioning log file for the log viewer's provisioning section
    if (this.logStorage) {
      const line = JSON.stringify({
        ts: event.timestampMs,
        phase: 'provisioning',
        eventType: event.eventType,
        message: event.detail,
        agentId: event.agentId,
      });
      const logPath = `executions/${runId}/jobs/${jobId}/provisioning.jsonl`;
      this.logStorage.append(logPath, line + '\n').catch((err) => {
        logger.warn('Failed to write provisioning log', {
          runId,
          jobId,
          error: toErrorMessage(err),
        });
      });
    }

    // 3. On a failure, persist the detail to the dispatch_queue row so the
    // queue-timeout reaper can surface the real cause (survives a leader
    // switch). `jobId` is the dispatch_queue row id. Fire-and-forget like the
    // provisioning.jsonl write; a failure here must not break dispatch.
    if (event.eventType === ScalerEventType.enum['scaler.failed'] && this.db) {
      this.db
        .updateTable('dispatch_queue')
        .set({ last_provisioning_error: event.detail })
        .where('id', '=', jobId)
        .execute()
        .catch((err) => {
          logger.warn('Failed to persist last_provisioning_error', {
            runId,
            jobId,
            error: toErrorMessage(err),
          });
        });
    }
  }

  /**
   * Append a line to a per-job orchestration log file via LogStorage.
   * Log format is JSONL for structured parsing on the frontend.
   * Path convention: executions/{runId}/jobs/{jobId}/orchestration.jsonl
   */
  private writeOrchLog(runId: string, jobId: string, phase: string, message: string): void {
    if (!this.logStorage) return;
    const line = JSON.stringify({ ts: Date.now(), phase, message });
    const logPath = `executions/${runId}/jobs/${jobId}/orchestration.jsonl`;
    this.logStorage.append(logPath, line + '\n').catch((err) => {
      logger.warn('Failed to write orchestration log', {
        runId,
        jobId,
        error: toErrorMessage(err),
      });
    });
  }

  /**
   * Build a human-readable description for a completed run.
   * Lists failed job names for non-success outcomes.
   */
  private buildRunDescription(
    run: RunState,
    status: Extract<ExecutionRunStatus, 'success' | 'failed' | 'cancelled'>,
  ): string | undefined {
    if (status === ExecutionRunStatus.enum.success) return undefined;

    // check-fail-on-drift run that failed solely because drift was detected.
    if (run.checkMode === CheckMode.enum['check-fail-on-drift'] && run.driftDetected) {
      return 'Drift detected in check mode (--fail-on-drift)';
    }

    const failedNames: string[] = [];
    for (const job of run.jobs.values()) {
      if (
        job.status === ExecutionJobStatus.enum.failed ||
        job.status === ExecutionJobStatus.enum.timed_out_stale ||
        job.status === ExecutionJobStatus.enum.drift_dropped
      ) {
        failedNames.push(job.name);
      }
    }

    if (failedNames.length > 0) {
      return `Failed jobs: ${failedNames.join(', ')}`;
    }

    return undefined;
  }

  /**
   * Compute the overall run status from job statuses.
   *
   * Per locked decision:
   * - success ONLY if ALL jobs pass (skipped jobs count as success)
   * - failed if ANY job failed or timed_out_stale
   * - cancelled if ANY job cancelled (and none failed)
   */
  private computeRunStatus(
    run: RunState,
  ): Extract<ExecutionRunStatus, 'success' | 'failed' | 'cancelled'> {
    // check-fail-on-drift (terraform -detailed-exitcode style): any step that
    // reported drift forces the run to fail, even when every job "succeeded".
    if (run.checkMode === CheckMode.enum['check-fail-on-drift'] && run.driftDetected) {
      return ExecutionRunStatus.enum.failed;
    }

    let hasFailed = false;
    let hasCancelled = false;

    for (const job of run.jobs.values()) {
      if (
        job.status === ExecutionJobStatus.enum.failed ||
        job.status === ExecutionJobStatus.enum.timed_out_stale ||
        job.status === ExecutionJobStatus.enum.drift_dropped
      ) {
        hasFailed = true;
      } else if (job.status === ExecutionJobStatus.enum.cancelled) {
        hasCancelled = true;
      }
    }

    if (hasFailed) return ExecutionRunStatus.enum.failed;
    if (hasCancelled) return ExecutionRunStatus.enum.cancelled;
    return ExecutionRunStatus.enum.success;
  }
}
