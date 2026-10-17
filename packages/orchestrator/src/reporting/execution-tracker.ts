/**
 * Execution state tracker with write-through DB persistence.
 *
 * Aggregates agent job/step status updates in memory (job name resolution, run
 * completion detection) and writes through to the
 * execution_runs/execution_jobs/execution_steps tables.
 *
 * Overall run status:
 * - success ONLY if ALL jobs succeed
 * - failed if ANY job fails
 * - cancelled if ANY job is cancelled (and none failed)
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { sql, type Kysely, type Updateable } from 'kysely';
import type { Database, ExecutionJobTable } from '../db/types.js';
import { JobKind } from '../db/types.js';
import { aggregateGateStatus } from '../pipeline/invoke-gate.js';
import { runSummaryFields, statusEpochField } from './run-summary-fields.js';
import { createLogger, getRequestContext, toErrorMessage } from '@kici-dev/shared';
import {
  ExecutionJobStatus,
  ExecutionRunStatus,
  ExecutionStepStatus,
  type InitFailure,
  RunFailureClass,
  ScalerEventType,
  TERMINAL_JOB_STATES,
  TERMINAL_RUN_STATES,
  CheckMode,
  CheckStepOutcome,
  OrchLogPhase,
  isFailureStatus,
} from '@kici-dev/engine';
import {
  executionsTotal,
  executionDurationSeconds,
  nonMonotonicJobStatusWritesTotal,
} from '../metrics/prometheus.js';
import type { ObserverRegistry } from '../ws/observer-registry.js';
import type { LogStorage } from './log-storage.js';
import { stepLogPath } from './step-log-path.js';
import { STOPPED_RUN_DISPATCH_REASON, type JobQueue } from '../queue/job-queue.js';
import { ROUND_JOB_PREFIX } from '../pipeline/global-eval-round.js';
import { extractPrecursorResult } from '../cache/precursor-result.js';
import {
  DEFAULT_RECOVERY_GRACE_MS,
  instanceLivenessGraceMs,
  liveInstanceIds,
} from '../cluster/instance-heartbeat.js';
import { evaluateDownstreams, checkSchedulerInvariant } from '../pipeline/needs-scheduler.js';
import { evaluateWave } from '../pipeline/wave-scheduler.js';
import { runDetached } from '../helpers/run-detached.js';

const logger = createLogger({ prefix: 'execution-tracker' });

/** How long to keep completed runs in memory before pruning (ms). */
const PRUNE_DELAY_MS = 5 * 60 * 1000; // 5 minutes

/**
 * True when a status-clobber-guarded write actually changed a row.
 *
 * Every terminal `execution_runs` write here is guarded so it cannot overwrite a
 * finished run. A rejected write means the caller's status is NOT this
 * orchestrator's record, so the caller must not forward it to the Platform
 * either: the Platform never revisits a terminal mirror row, so one unguarded
 * forward diverges the two planes permanently.
 *
 * Accepts `numUpdatedRows` (UPDATE) and `numInsertedOrUpdatedRows`
 * (INSERT ... ON CONFLICT DO UPDATE).
 */
function guardedWriteApplied(
  result: { numUpdatedRows?: bigint; numInsertedOrUpdatedRows?: bigint } | undefined,
): boolean {
  if (!result) return false;
  return (result.numUpdatedRows ?? result.numInsertedOrUpdatedRows ?? 0n) > 0n;
}

/**
 * The value `execution_runs.workflow_repo_identifier` takes for a run: the
 * repository that defines the workflow, but only when it is not the repository
 * the run acted on.
 *
 * Narrow exactly once per recording site: the column and the `execution.status`
 * forward are written from the same result, so the DB and the wire cannot
 * disagree about what "global" means. `undefined` (never `''`, never `null`) so
 * the caller can spread it conditionally into both.
 */
function crossRepoWorkflowRepoOf(args: {
  repoIdentifier: string;
  workflowRepoIdentifier?: string | null;
}): string | undefined {
  return args.workflowRepoIdentifier != null && args.workflowRepoIdentifier !== args.repoIdentifier
    ? args.workflowRepoIdentifier
    : undefined;
}

/**
 * The repository that defines a run's workflow, with the commit the run
 * dispatched from it and that repository's registered branch.
 */
export interface WorkflowRepoProvenance {
  identifier: string;
  sha: string | null;
  branch: string | null;
}

/**
 * The workflow-repository provenance a run records: the whole provenance when
 * the workflow is defined in a repository other than the one the run acted on,
 * `undefined` otherwise. The same single narrowing as
 * {@link crossRepoWorkflowRepoOf}, so the identifier, commit, and branch are
 * written together or not at all.
 */
function crossRepoProvenanceOf(
  repoIdentifier: string,
  workflowRepo: WorkflowRepoProvenance | null | undefined,
): WorkflowRepoProvenance | undefined {
  return workflowRepo != null && workflowRepo.identifier !== repoIdentifier
    ? workflowRepo
    : undefined;
}

/** The `execution_runs` columns a cross-repository provenance fills. */
function workflowProvenanceColumns(provenance: WorkflowRepoProvenance): {
  workflow_repo_identifier: string;
  workflow_sha: string | null;
  workflow_branch: string | null;
} {
  return {
    workflow_repo_identifier: provenance.identifier,
    workflow_sha: provenance.sha,
    workflow_branch: provenance.branch,
  };
}

/**
 * The `chain_depth` column value for a run recorded by a pre-dispatch path (a
 * hold, an init failure, or a build that failed before tracking started).
 *
 * Stamped on the INSERT, not a follow-up UPDATE, because these paths write the
 * row and return. A held run that lost its depth is resumable and can fire its
 * own invoke gate; the chain-depth circuit breaker reads the column back, and a
 * `0` means "this run starts a chain", so the breaker fails OPEN and an
 * unbounded summon recursion goes undetected.
 *
 * **Depth 0 writes nothing, deliberately.** `0` is the column default, and
 * `stampChainDepth` applies the same rule on the normal dispatch path, so every
 * writer agrees on when it writes. The dispatch context (and the adapter that
 * fills it) carries an explicit `0` verbatim, because a context is serialized
 * and resumed and normalizing there would lose what the caller stated; the
 * normalization happens once, here, at the column.
 */
function inheritedChainDepth(chainDepth: number | undefined): { chain_depth?: number } {
  return chainDepth !== undefined && chainDepth > 0 ? { chain_depth: chainDepth } : {};
}

/**
 * The run a re-run re-executes and the root of its re-run chain. Stamped by the
 * pre-dispatch writers too, so a re-run that is held or fails before its first
 * job still records what it re-ran.
 */
export interface RerunLineage {
  parentRunId: string;
  originalRunId: string;
}

/** The lineage columns of a re-run's row; empty for a first run. */
function rerunLineageColumns(lineage: RerunLineage | undefined): {
  parent_run_id?: string;
  original_run_id?: string;
} {
  return lineage
    ? { parent_run_id: lineage.parentRunId, original_run_id: lineage.originalRunId }
    : {};
}

/**
 * The `trigger_decision` blob for a run recorded by a pre-dispatch path.
 *
 * These paths write the row before any decision summary exists, so the column
 * is `null` unless the dispatch was a failure-lifecycle one; then the whole blob
 * is the marker `EventRouter.isFailureLifecycleRun` reads back.
 *
 * Load-bearing for a HELD run: it resumes onto this same row
 * (`onExecutionStarted`'s conflict path fills only event-context and
 * workflow-provenance gaps, so it keeps this column), and without the marker a
 * `workflows_failed_batch` accumulator folds its completion back into the batch
 * that spawned it — a notifier re-triggering itself. An init failure records
 * the marker for consistency only: that path emits no completion event today.
 */
function failureLifecycleTriggerDecision(dispatched: boolean | undefined): string | null {
  return dispatched ? JSON.stringify({ dispatchedByFailureLifecycle: true }) : null;
}

/** The `trigger_decision` key a held evaluation round records its covered workflows under. */
export const HELD_ROUND_WORKFLOWS_KEY = 'heldRoundWorkflows';

/**
 * The `trigger_decision` blob of a held run: the failure-lifecycle marker, and
 * for a held evaluation round the workflows it covers; null when it carries
 * neither.
 *
 * The blob, not a new column: a held round's row has no decision summary, the
 * blob already carries markers read back by key, and nothing forwards or
 * renders it — so no migration, and nothing an older reader sees changes.
 */
function heldRunTriggerDecision(args: {
  dispatchedByFailureLifecycle?: boolean;
  heldRoundWorkflows?: readonly string[];
}): string | null {
  const blob = {
    ...(args.dispatchedByFailureLifecycle && { dispatchedByFailureLifecycle: true }),
    ...(args.heldRoundWorkflows && { [HELD_ROUND_WORKFLOWS_KEY]: [...args.heldRoundWorkflows] }),
  };
  return Object.keys(blob).length > 0 ? JSON.stringify(blob) : null;
}

/** Context passed to onExecutionComplete for commit status updates. */
export interface ExecutionContext {
  workflowName: string;
  provider: string;
  repoIdentifier: string;
  sha: string;
  /** True when the run executed an uploaded local working tree (`kici run remote`). */
  localWorkingTree?: boolean;
  installationId?: number;
  requestId?: string;
  routingKey?: string;
  /**
   * The repository that DEFINES the workflow, when that is not
   * `repoIdentifier` — a global workflow authored in one repository and
   * dispatched against another. Set only when the two differ, so "present"
   * marks a cross-repository global run; forwarded to the Platform on
   * `execution.status`.
   */
  workflowRepoIdentifier?: string;
  /**
   * True when this run records a global evaluation round rather than a
   * workflow. Forwarded to the Platform, which mirrors it on the run row.
   */
  isGlobalEvalRound?: boolean;
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
  /** Agent provenance label when triggered through an agent credential. */
  triggeredByAgentLabel?: string | null;
  /**
   * Provider login of the person who triggered the run (pusher / PR author).
   * Captured for all event types; forwarded to the Platform run projection and
   * used to resolve actor-scope notifications.
   */
  triggerActorUsername?: string | null;
  /** Immutable provider user id of the triggering actor (preferred for resolution). */
  triggerActorUserId?: string | null;
  /**
   * Why a terminal run failed (`RunFailureClass`). Set on terminal-failed /
   * cancelled runs; forwarded to the Platform on `execution.status` so managed
   * subscriptions can match on it. Null/undefined for success or non-terminal.
   */
  failureClass?: RunFailureClass | null;
  /**
   * The run's status generation (`execution_runs.status_epoch`), forwarded on
   * `execution.status` as `statusEpoch`. Absent reads as 0. It rises only when
   * a run leaves a terminal status to continue, so the Platform can keep a
   * finished run finished against a non-terminal frame that arrives late.
   */
  statusEpoch?: number;
  /**
   * Resolved trust tier of the run's ref, and which branch's lock file it was
   * evaluated against. Mirror the `execution_runs.trust_tier` /
   * `lock_file_source` columns; both absent for a run whose trust never
   * resolved. Read by the check-run reporter to name the reduced-privilege
   * posture on a job's completion summary.
   */
  trustTier?: string;
  lockFileSource?: string;
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
  jobResults: Array<{ name: string; status: string; outputs?: Record<string, unknown> }>;
  routingKey?: string;
  repo: string;
  /** Why the run failed (`RunFailureClass`); carried onto the `__workflow_complete` event. */
  failureClass?: string;
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
  /**
   * Job payload carried by the status update (step results, error, duration).
   * Feeds the enriched check-run summary and the failure description.
   */
  data?: Record<string, unknown>;
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
  /**
   * Drop the in-process state a run leaves behind — its pending job contexts
   * and its still-open eval gates.
   *
   * Separate from {@link ExecutionTrackerDeps.onExecutionComplete}, which is NOT
   * a terminalization chokepoint: it fires on the paths that finish a run whose
   * jobs ran (`completeRun`, and both stale-detector arms) and on none that
   * terminalize a run whose jobs never did — `failRun` (the expired-approval
   * sweep and every pre-dispatch abort) and `cancelHeldRun` (an install gate
   * rejected). Those runs are the likeliest to hold a pending job context, since
   * a context is stored only for a job that was gated rather than dispatched.
   *
   * Synchronous by contract: the in-memory half must not be deferred behind an
   * await the caller does not hold; the DB half is fire-and-forget inside the
   * callback.
   */
  onRunTerminalCleanup?: (runId: string) => void;
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
    /** Ordered bound deployment-context names for this job (multi-env jobs). */
    contexts?: string[],
    /** The workflow that defines the job, when recorded. */
    workflowName?: string,
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
  /**
   * Optional live forward of orchestration/provisioning log lines to Platform,
   * fired in addition to persisting them to `logStorage`. Platform fans these
   * out to run-detail browser subscribers as `orch-log.lines`. Best-effort:
   * a push failure must never break dispatch.
   *
   * SECURITY: like `onRunEventEmit`, this payload MUST NOT carry an `orgId`.
   * The Platform attributes the tenant from `authState.orgId`.
   */
  onOrchLog?: (chunk: {
    runId: string;
    jobId: string;
    phase: OrchLogPhase;
    lines: string[];
    ts: number;
  }) => void;
  /** Optional log storage for writing per-job orchestration logs (JSONL). */
  logStorage?: LogStorage;
  /** Org ID for this orchestrator instance (used in run.event emission). */
  orgId?: string;
  /** Optional job queue for cascading run failures to dispatch_queue entries. */
  jobQueue?: JobQueue;
  /**
   * Resolves a routing key to its owning org, stamped on
   * `execution_runs.customer_id` at insert so the concurrency-gate running count
   * is scoped per tenant. Injected (bound to `(rk) => resolveOrgId(db, rk)`) to
   * avoid a pipeline import cycle. Absent, or for a run with no routing key, the
   * row falls back to the `'__default__'` column default (the no-source org).
   */
  resolveOrgId?: (routingKey: string) => Promise<string>;
  /**
   * This coordinator's cluster instance id. Written to
   * `execution_runs.registration_window_instance_id` while this coordinator's
   * dispatch pipeline still has jobs to register for a run, so a sibling that
   * rehydrates the run from the database defers finalizing it. Optional for
   * the same reason `JobQueue`'s is: a worker with no cluster identity leaves
   * it undefined, holds no durable window, and reads every holder as a sibling.
   */
  instanceId?: string;
  /**
   * How stale a `cluster_instances` heartbeat may be and still read as live,
   * for the registration-window holder check. Defaults to
   * {@link instanceLivenessGraceMs} at the default recovery grace period —
   * the same window the dispatch queue's ownership predicates use.
   */
  instanceLivenessGraceMs?: number;
}

/** The org used when no routing key / resolver is available (matches the column DEFAULT). */
const DEFAULT_CUSTOMER_ID = '__default__';

/**
 * Whether a live job report may reopen a run row: the run failed, and not on a
 * build failure. Mirrors the guard on the reopen UPDATE itself.
 */
function isReopenableFailure(status: string, failureReason: string | null): boolean {
  if (status !== ExecutionRunStatus.enum.failed) return false;
  return failureReason === null || !failureReason.toLowerCase().includes('build');
}

/** In-memory state for a single execution run. */
interface RunState {
  /** Current run-level status (pending until first job starts running). */
  status: Extract<ExecutionRunStatus, 'pending' | 'running' | 'cancelling'>;
  workflowName: string;
  provider: string;
  repoIdentifier: string;
  /**
   * The repository that DEFINES the workflow, held only when it differs from
   * `repoIdentifier` — see {@link ExecutionContext.workflowRepoIdentifier}.
   * Narrowing to the differing case happens once, where the run is recorded, so
   * every forward and the DB column cannot disagree about what "global" means.
   */
  workflowRepoIdentifier?: string;
  sha: string;
  /** True when the run executed an uploaded local working tree (`kici run remote`). */
  localWorkingTree?: boolean;
  installationId?: number;
  requestId?: string;
  routingKey?: string;
  ref?: string;
  triggerEvent?: string;
  commitMessage?: string;
  parentRunId?: string | null;
  originalRunId?: string | null;
  triggeredBy?: string | null;
  triggeredByAgentLabel?: string | null;
  triggerActorUsername?: string | null;
  triggerActorUserId?: string | null;
  concurrency?: { cancelInProgress?: boolean; max?: number };
  failureReason?: string;
  /**
   * Resolved trust tier and lock-file branch of the run, mirroring the
   * `execution_runs.trust_tier` / `lock_file_source` columns. Stamped by
   * `setRunTrustContext` after the row is recorded — the same post-start
   * mutation shape as `driftDetected` and `failureReason` — so the check-run
   * reporter can name the reduced-privilege posture on a job's completion
   * summary. Absent for a run whose trust never resolved.
   */
  trustTier?: string;
  lockFileSource?: string;
  /** Run mode for idempotent steps (`apply` | `check` | `check-fail-on-drift`). */
  checkMode?: string;
  /** Set true once any step reports a `dry-run` outcome (drift detected). */
  driftDetected?: boolean;
  startedAt: number;
  completedAt?: number;
  /**
   * The run's status generation (`execution_runs.status_epoch`), forwarded on
   * every `execution.status` frame. Absent reads as 0: a run this coordinator
   * started has never left a terminal status.
   */
  statusEpoch?: number;
  /**
   * Set on a run rehydrated from a `failed` row that a live job report may
   * reopen ({@link ExecutionTracker.reopenRecoveredRun}). Cleared once the
   * reopen is decided.
   */
  reopenableFailedRow?: boolean;
  /**
   * Outstanding "jobs are still to be registered" tokens; above zero,
   * `isRunComplete` is false whatever jobs are tracked. Incremented by
   * `holdRunForPendingJobs`, decremented by `releasePendingJobsHold`. A count,
   * not a flag: the source-pack build window, each deferred init job and each
   * deferred dynamic entry can be in flight at once, and each must hold the run
   * open until its own jobs land.
   */
  pendingJobRegistrations?: number;
  jobs: Map<
    string,
    {
      name: string;
      /** The workflow that defines the job; see {@link TrackedJobRow.workflowName}. */
      workflowName?: string;
      status: string;
      startedAt?: number;
      agentId?: string;
      runsOnLabels?: string[];
      contexts?: string[];
    }
  >;
}

/**
 * The per-job fields the tracker persists to an execution_jobs row.
 *
 * Shared by every registration entry point (`onExecutionStarted`,
 * `addJobsToRun`) rather than restated inline: inline copies drift on which
 * optional fields they carry, so a new column silently goes unwritten from one.
 */
export interface TrackedJobRow {
  jobId: string;
  jobName: string;
  /**
   * The workflow that defines the job. A fixture run with no `--workflow` runs
   * every matched workflow under one run id, so the run's own workflow does not
   * name it. `onExecutionStarted` stamps its own workflow on a job without one;
   * `addJobsToRun` inherits it from the placeholder the job replaces.
   */
  workflowName?: string;
  matrixValues?: Record<string, unknown>;
  runsOnLabels?: string[];
  baseJobName?: string;
  variantKind?: string;
  variantLabel?: string;
  waveGated?: boolean;
  waveMaxParallel?: number;
  waveFailFast?: boolean;
  contexts?: string[];
  /**
   * The `gitCredentials` map this job's lock entry declared, verbatim.
   * Persisted so the credential relay can check a workflow-supplied ref against
   * server truth without re-parsing a lock file on a hot path — so it must
   * match the lock exactly, including a `<name>Value` the lock declared.
   */
  gitCredentials?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  skippedContexts?: string[];
  envWarning?: string;
  /** `gate` for an invoke gate, `proxy` for a summoned-run mirror. Defaults to `standard`. */
  jobKind?: JobKind;
  /** For a proxy job, the summoned run it mirrors. */
  summonedRunId?: string;
  /** For a gate job, its wall-clock timeout in ms (orchestrator-swept). */
  timeoutMs?: number;
}

/**
 * `Failed jobs: a, b` for a run's failed jobs, or undefined when none failed.
 * A run spanning several workflows names each job with its workflow
 * (`repro-406 / init-fails`), so the summary points at the workflow to fix.
 */
function failedJobsSummary(
  jobs: ReadonlyArray<{ name: string; workflowName?: string | null; status: string }>,
): string | undefined {
  const workflows = new Set(jobs.map((j) => j.workflowName).filter(Boolean));
  const failed = jobs
    .filter((j) => isFailureStatus(j.status))
    .map((j) => (workflows.size > 1 && j.workflowName ? `${j.workflowName} / ${j.name}` : j.name));
  return failed.length > 0 ? `Failed jobs: ${failed.join(', ')}` : undefined;
}

/** Stamp each job with `workflowName`, keeping a workflow a job already names. */
export function jobsOfWorkflow<T extends TrackedJobRow>(workflowName: string, jobs: T[]): T[] {
  return jobs.map((job) => ({ ...job, workflowName: job.workflowName ?? workflowName }));
}

/**
 * Build the mutable column set for a tracked job's execution_jobs upsert — the
 * fields written on both the initial INSERT and the (run_id, job_id) conflict
 * update. `run_id` / `job_id` / `routing_key` / `matrix_values` are set by the
 * caller (INSERT only).
 */
function trackedJobMutableColumns(
  job: TrackedJobRow,
  runsOnLabelsJson: string | null,
  dispatchedContexts: string[] | undefined,
): Updateable<ExecutionJobTable> & { job_name: string } {
  return {
    job_name: job.jobName,
    ...(job.workflowName && { workflow_name: job.workflowName }),
    ...(job.baseJobName && { base_job_name: job.baseJobName }),
    ...(job.variantKind && { variant_kind: job.variantKind }),
    ...(job.variantLabel && { variant_label: job.variantLabel }),
    ...(job.waveGated && { wave_gated: true }),
    ...(job.waveMaxParallel !== undefined && { wave_max_parallel: job.waveMaxParallel }),
    ...(job.waveFailFast !== undefined && { wave_fail_fast: job.waveFailFast }),
    ...(runsOnLabelsJson && { runs_on_labels: runsOnLabelsJson }),
    ...(job.contexts?.length && { contexts: JSON.stringify(job.contexts) }),
    ...(job.gitCredentials &&
      Object.keys(job.gitCredentials).length > 0 && {
        git_credentials: JSON.stringify(job.gitCredentials),
      }),
    ...(job.skippedContexts?.length && {
      skipped_contexts: JSON.stringify(job.skippedContexts),
    }),
    ...(job.envWarning && { env_warning: job.envWarning }),
    ...(job.jobKind && { job_kind: job.jobKind }),
    ...(job.summonedRunId && { summoned_run_id: job.summonedRunId }),
    ...(job.timeoutMs !== undefined && { timeout_ms: job.timeoutMs }),
    ...(dispatchedContexts?.length && {
      dispatched_contexts: JSON.stringify(dispatchedContexts),
    }),
  };
}

/**
 * Render the human-readable text of a status message's `error` field.
 *
 * A JOB carries a plain string, but a STEP carries the structured
 * `{ message, exitCode, signal }` from `step.complete`, where `String()` yields
 * `[object Object]`. Reads `.message` when present and falls back to `String()`,
 * so any shape produces readable text.
 */
function errorText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'message' in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(value);
}

export class ExecutionTracker {
  private readonly db: Kysely<Database>;
  private readonly observerRegistry?: ObserverRegistry;
  private readonly onExecutionComplete?: ExecutionTrackerDeps['onExecutionComplete'];
  private readonly onRunTerminalCleanup?: ExecutionTrackerDeps['onRunTerminalCleanup'];
  private readonly onStepStatusForward?: ExecutionTrackerDeps['onStepStatusForward'];
  private readonly onRunPruned?: ExecutionTrackerDeps['onRunPruned'];
  private readonly onWorkflowComplete?: ExecutionTrackerDeps['onWorkflowComplete'];
  private readonly onJobComplete?: ExecutionTrackerDeps['onJobComplete'];
  private readonly onExecutionStatusChange?: ExecutionTrackerDeps['onExecutionStatusChange'];
  private readonly onJobStatusChange?: ExecutionTrackerDeps['onJobStatusChange'];
  private readonly onRunEventEmit?: ExecutionTrackerDeps['onRunEventEmit'];
  private readonly onOrchLog?: ExecutionTrackerDeps['onOrchLog'];
  private readonly logStorage?: LogStorage;
  private readonly orgId?: string;
  private readonly jobQueue?: JobQueue;
  private readonly resolveOrgIdFn?: ExecutionTrackerDeps['resolveOrgId'];
  private readonly instanceId?: string;
  private readonly livenessGraceMs: number;
  private readonly runs = new Map<string, RunState>();
  /**
   * Per-run chain of the durable registration-window writes. The write that
   * opens a window is fire-and-forget from the synchronous
   * `holdRunForPendingJobs`; the clear on the last release awaits the chain
   * first, so a clear can never overtake the open it undoes.
   */
  private readonly registrationWindowWrites = new Map<string, Promise<void>>();
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
   * Per-(run, job) raw log bytes: runId -> jobId -> bytes.
   *
   * Fed by `logBytesStreamed` on terminal `step.status` messages, written to
   * `execution_jobs.log_bytes` at job terminal state and summed into
   * `execution_runs.log_bytes` at run completion. Deleted on run prune.
   */
  private readonly jobLogBytes = new Map<string, Map<string, number>>();
  /** Callback fired when a job's needs are satisfied and it's ready for dispatch. */
  onJobReadyCallback?: (runId: string, jobName: string) => Promise<void>;

  constructor(deps: ExecutionTrackerDeps) {
    this.db = deps.db;
    this.observerRegistry = deps.observerRegistry;
    this.onExecutionComplete = deps.onExecutionComplete;
    this.onRunTerminalCleanup = deps.onRunTerminalCleanup;
    this.onStepStatusForward = deps.onStepStatusForward;
    this.onRunPruned = deps.onRunPruned;
    this.onWorkflowComplete = deps.onWorkflowComplete;
    this.onJobComplete = deps.onJobComplete;
    this.onExecutionStatusChange = deps.onExecutionStatusChange;
    this.onJobStatusChange = deps.onJobStatusChange;
    this.onRunEventEmit = deps.onRunEventEmit;
    this.onOrchLog = deps.onOrchLog;
    this.logStorage = deps.logStorage;
    this.orgId = deps.orgId;
    this.jobQueue = deps.jobQueue;
    this.resolveOrgIdFn = deps.resolveOrgId;
    this.instanceId = deps.instanceId;
    this.livenessGraceMs =
      deps.instanceLivenessGraceMs ?? instanceLivenessGraceMs(DEFAULT_RECOVERY_GRACE_MS);
  }

  /**
   * Resolve the owning org for an `execution_runs` row from its routing key.
   * Falls back to the `'__default__'` org (the column default) when the run has
   * no routing key or no resolver is injected (single-tenant / test contexts).
   */
  private async resolveCustomerId(routingKey: string | null | undefined): Promise<string> {
    if (routingKey == null || !this.resolveOrgIdFn) return DEFAULT_CUSTOMER_ID;
    return this.resolveOrgIdFn(routingKey);
  }

  /**
   * Register a callback fired when a job's needs become satisfied.
   * The processor sets this to dispatch newly-ready jobs to agents.
   */
  setOnJobReadyCallback(cb: (runId: string, jobName: string) => Promise<void>): void {
    this.onJobReadyCallback = cb;
  }

  /**
   * Record a new execution run with its initial jobs: inserts the
   * execution_runs and execution_jobs rows and sets up in-memory state.
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
    jobs: TrackedJobRow[],
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
    /** True when the run executes an uploaded local working tree (`kici run remote`). */
    localWorkingTree?: boolean,
    /** Provider login of the triggering actor (pusher / PR author). */
    triggerActorUsername?: string | null,
    /** Immutable provider user id of the triggering actor. */
    triggerActorUserId?: string | null,
    /** Agent provenance label when triggered through an agent credential. */
    triggeredByAgentLabel?: string | null,
    /** Pull-request number for PR-triggered runs; null/omitted for non-PR runs. */
    prNumber?: number | null,
    /**
     * The repository that DEFINES the workflow, with the commit dispatched from
     * it and its registered branch, when that is not `repoIdentifier` — an
     * organization-wide workflow authored in one repository and dispatched
     * against another. Omitted/null for every per-repository run, where the two
     * are the same repository.
     */
    workflowRepo?: WorkflowRepoProvenance | null,
    /**
     * Pull-request head context, resolved from the normalized event.
     *
     * Written HERE, on the authoritative insert, and never in the
     * fire-and-forget post-start update `trust_tier` uses. A lost write would
     * leave `is_fork` NULL, which every claim renders `'unresolved'` — correct
     * for a legacy row, and a silent policy failure for a live one.
     */
    eventContext?: {
      headRef?: string | null;
      headRepository?: string | null;
      /**
       * NULL only when the event genuinely does not resolve one: a PR payload
       * carrying no head or base repository. A non-PR event resolves to
       * `false`, because a push has no fork dimension — leaving it unresolved
       * would make every `is_fork = false` trust policy reject legitimate
       * pushes, and the customer's fix for that would re-open the hole.
       */
      isFork?: boolean | null;
      /**
       * The event the OIDC subject is derived from, when `triggerEvent` is not
       * it. Set only by the re-run path, which records `'rerun'` as its trigger
       * event and carries the original run's event here so a re-run of a pull
       * request keeps the pull-request subject.
       */
      subjectTriggerEvent?: string | null;
    },
  ): Promise<void> {
    const now = new Date();

    // Narrow to "a DIFFERENT repository" exactly once: the run row, the
    // in-memory state and every Platform forward read this one value, so null
    // keeps meaning "the workflow lives in this run's own repository".
    const crossRepoProvenance = crossRepoProvenanceOf(repoIdentifier, workflowRepo);
    const crossRepoWorkflowRepo = crossRepoProvenance?.identifier;

    const workflowJobs = jobsOfWorkflow(workflowName, jobs);
    const jobMap: RunState['jobs'] = new Map();
    for (const job of workflowJobs) {
      jobMap.set(job.jobId, {
        name: job.jobName,
        ...(job.workflowName && { workflowName: job.workflowName }),
        status: ExecutionJobStatus.enum.pending,
        ...(job.runsOnLabels?.length && { runsOnLabels: job.runsOnLabels }),
        ...(job.contexts?.length && { contexts: job.contexts }),
      });
    }

    // installationId feeds commit status updates.
    const installationId =
      typeof (providerContext as Record<string, unknown>).installationId === 'number'
        ? ((providerContext as Record<string, unknown>).installationId as number)
        : undefined;

    // A run spanning several workflows registers once per workflow under one
    // run id (a fixture run with no `--workflow`). A later workflow joins the
    // live run: replacing it would drop the jobs already registered, and the run
    // would complete while they are still running.
    const liveRun = this.runs.get(runId);
    const joinsLiveRun = liveRun !== undefined && liveRun.completedAt === undefined;
    if (joinsLiveRun) {
      for (const [jobId, job] of jobMap) {
        if (!liveRun.jobs.has(jobId)) liveRun.jobs.set(jobId, job);
      }
    } else
      this.runs.set(runId, {
        status: ExecutionRunStatus.enum.pending,
        workflowName,
        provider,
        repoIdentifier,
        ...(crossRepoWorkflowRepo && { workflowRepoIdentifier: crossRepoWorkflowRepo }),
        sha,
        ...(localWorkingTree && { localWorkingTree: true }),
        installationId,
        requestId: getRequestContext().requestId,
        routingKey,
        ref,
        triggerEvent,
        commitMessage,
        parentRunId,
        originalRunId,
        triggeredBy,
        triggeredByAgentLabel,
        triggerActorUsername,
        triggerActorUserId,
        concurrency,
        ...(checkMode != null && { checkMode }),
        startedAt: now.getTime(),
        jobs: jobMap,
      });

    // A pre-dispatch path may already have written the row; the conflict path
    // below fills only the gaps it left.
    const customerId = await this.resolveCustomerId(routingKey);
    await this.db
      .insertInto('execution_runs')
      .values({
        run_id: runId,
        routing_key: routingKey ?? null,
        customer_id: customerId,
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
        ...(triggerEvent != null && { trigger_event: triggerEvent }),
        ...(eventContext?.headRef != null && { head_ref: eventContext.headRef }),
        ...(eventContext?.headRepository != null && {
          head_repository: eventContext.headRepository,
        }),
        ...(eventContext?.isFork != null && { is_fork: eventContext.isFork }),
        ...(eventContext?.subjectTriggerEvent != null && {
          subject_trigger_event: eventContext.subjectTriggerEvent,
        }),
        ...(parentRunId != null && { parent_run_id: parentRunId }),
        ...(originalRunId != null && { original_run_id: originalRunId }),
        ...(triggeredBy != null && { triggered_by: triggeredBy }),
        ...(triggeredByAgentLabel != null && {
          triggered_by_agent_label: triggeredByAgentLabel,
        }),
        ...(prNumber != null && { pr_number: prNumber }),
        ...((triggerActorUsername != null || triggerActorUserId != null) && {
          trigger_actor_provider: provider,
        }),
        ...(triggerActorUsername != null && { trigger_actor_username: triggerActorUsername }),
        ...(triggerActorUserId != null && { trigger_actor_user_id: triggerActorUserId }),
        ...(workflowTimeoutMs != null && { workflow_timeout_ms: workflowTimeoutMs }),
        ...(checkMode != null && { check_mode: checkMode }),
        // Only when it differs from the repository the run acted on.
        ...(crossRepoProvenance && workflowProvenanceColumns(crossRepoProvenance)),
      })
      // The conflict path fills only the event context and workflow provenance.
      // A pre-dispatch writer (an early start, a held run resuming) knows no
      // event, so DO NOTHING would leave these NULL forever: the git credential
      // relay needs `trigger_event` for a context's trigger-type filters, and the
      // OIDC mint needs the head context to tell a fork pull request from a push
      // to the same base branch. A held row may lack the workflow commit and
      // branch, which a re-run dispatches. COALESCE only fills a gap; every other
      // column stays owned by whoever inserted the row.
      .onConflict((oc) =>
        oc.column('run_id').doUpdateSet({
          trigger_event: sql`COALESCE(execution_runs.trigger_event, EXCLUDED.trigger_event)`,
          head_ref: sql`COALESCE(execution_runs.head_ref, EXCLUDED.head_ref)`,
          head_repository: sql`COALESCE(execution_runs.head_repository, EXCLUDED.head_repository)`,
          is_fork: sql`COALESCE(execution_runs.is_fork, EXCLUDED.is_fork)`,
          subject_trigger_event: sql`COALESCE(execution_runs.subject_trigger_event, EXCLUDED.subject_trigger_event)`,
          workflow_repo_identifier: sql`COALESCE(execution_runs.workflow_repo_identifier, EXCLUDED.workflow_repo_identifier)`,
          workflow_sha: sql`COALESCE(execution_runs.workflow_sha, EXCLUDED.workflow_sha)`,
          workflow_branch: sql`COALESCE(execution_runs.workflow_branch, EXCLUDED.workflow_branch)`,
        }),
      )
      .execute();

    // Upsert, to tolerate a race with onJobStatus.
    await this.insertTrackedJobRows(runId, routingKey ?? null, dispatchedContexts, workflowJobs);

    if (!joinsLiveRun) executionsTotal.add(1, { status: ExecutionRunStatus.enum.pending });

    logger.info(joinsLiveRun ? 'Workflow joined running execution' : 'Execution started', {
      runId,
      workflowName,
      jobCount: jobs.length,
    });

    this.emitRunEvent(runId, 'orchestrator.dispatch', {
      metadata: { workflowName, triggerType: triggerEvent },
    });

    for (const job of jobs) {
      this.writeOrchLog(runId, job.jobId, OrchLogPhase.enum.dispatch, 'Job dispatched to queue');
    }

    // A joining workflow forwards the run as it stands: its status, its first
    // workflow and its start, with the job count across every workflow.
    const run = this.runs.get(runId)!;
    this.onExecutionStatusChange?.(
      runId,
      run.status,
      {
        workflowName: run.workflowName,
        provider,
        repoIdentifier,
        ...(crossRepoWorkflowRepo && { workflowRepoIdentifier: crossRepoWorkflowRepo }),
        sha,
        ...(localWorkingTree && { localWorkingTree: true }),
        installationId,
        requestId: getRequestContext().requestId,
        routingKey,
        ref,
        triggerEvent,
        commitMessage,
        parentRunId,
        originalRunId,
        triggeredBy,
        triggerActorUsername,
        triggerActorUserId,
      },
      run.jobs.size,
      run.startedAt,
    );
  }

  /**
   * Upsert one execution_jobs row per dispatched job (idempotent on
   * (run_id, job_id) to tolerate a race with an early `onJobStatus`). The
   * `routing_key` is denormalized (see migration 006) so cold-store archival
   * partitions by it without joining execution_runs.
   */
  private async insertTrackedJobRows(
    runId: string,
    routingKey: string | null,
    dispatchedContexts: string[] | undefined,
    jobs: TrackedJobRow[],
  ): Promise<void> {
    for (const job of jobs) {
      const runsOnLabelsJson = job.runsOnLabels?.length ? JSON.stringify(job.runsOnLabels) : null;
      const mutable = trackedJobMutableColumns(job, runsOnLabelsJson, dispatchedContexts);
      await this.db
        .insertInto('execution_jobs')
        .values({
          run_id: runId,
          job_id: job.jobId,
          routing_key: routingKey,
          matrix_values: job.matrixValues ? JSON.stringify(job.matrixValues) : null,
          ...mutable,
        })
        .onConflict((oc) => oc.columns(['run_id', 'job_id']).doUpdateSet(mutable))
        .execute();
    }
    if (jobs.length > 0) await this.cancelJobsOfStoppedRun(runId, jobs);
  }

  /**
   * Cancel job rows just registered under a run that has already stopped.
   *
   * A job registers after its dispatch, so a cancel landing in between leaves
   * the run terminal and the job row `pending`. The queue refuses that dispatch
   * (`JobQueue.insertDispatched`), so no agent will report on it; the row is
   * cancelled here, as the cancel cancels the queued jobs it can see.
   */
  private async cancelJobsOfStoppedRun(runId: string, jobs: TrackedJobRow[]): Promise<void> {
    const stopped = [...TERMINAL_RUN_STATES, ExecutionRunStatus.enum.cancelling];
    await this.db
      .updateTable('execution_jobs')
      .set({
        status: ExecutionJobStatus.enum.cancelled,
        completed_at: new Date(),
        error_message: STOPPED_RUN_DISPATCH_REASON,
        routing_reason: null,
      })
      .where('run_id', '=', runId)
      .where(
        'job_id',
        'in',
        jobs.map((job) => job.jobId),
      )
      .where('status', 'in', [ExecutionJobStatus.enum.pending, ExecutionJobStatus.enum.queued])
      // fails-when: a job registered under a cancelled run stays pending forever
      // breaks-if-wrong: a job registered under a running run must stay pending
      .where(
        sql<boolean>`EXISTS (SELECT 1 FROM execution_runs er WHERE er.run_id = execution_jobs.run_id AND er.status IN (${sql.join(stopped.map((status) => sql`${status}`))}))`,
      )
      .execute();
  }

  /**
   * Find the synthetic needs-pending job ID that dispatchReadyJob replaces.
   *
   * Cluster correctness: the peer that ingested the webhook inserts the
   * synthetic row, but `dispatchReadyJob` can fire on a peer whose in-memory map
   * has no entry for this run. The DB fallback cleans up the synthetic row
   * whichever peer owns the downstream dispatch.
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
   * Whether a rerouted job has visibly started, read from the shared
   * `execution_jobs` row rather than from a relayed progress frame.
   *
   * The spawn-window backstop learns progress from `job.progress`, which only a
   * WORKER peer (no database) sends. A peer COORDINATOR writes the status
   * straight into this table, so wire silence says nothing and the backstop
   * would cancel a healthy job.
   *
   * False when no row exists yet or the row is still `pending`; the
   * `started_at` half covers a status already moved on to a terminal value.
   */
  async hasJobStarted(runId: string, jobId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('execution_jobs')
      .select(['status', 'started_at'])
      .where('run_id', '=', runId)
      .where('job_id', '=', jobId)
      .executeTakeFirst();
    if (!row) return false;
    return row.started_at !== null || row.status !== ExecutionJobStatus.enum.pending;
  }

  /**
   * Whether the shared `execution_jobs` row records a terminal state.
   *
   * Companion to {@link hasJobStarted}: a peer COORDINATOR relays no terminal
   * `job.progress`, so the row is the routing coordinator's only signal that the
   * job is over and its reroute tracking can be released.
   *
   * False when no row exists — an absent row is a job not yet started.
   */
  async isJobTerminal(runId: string, jobId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('execution_jobs')
      .select(['status'])
      .where('run_id', '=', runId)
      .where('job_id', '=', jobId)
      .executeTakeFirst();
    return row ? TERMINAL_JOB_STATES.has(row.status) : false;
  }

  /**
   * The status `execution_jobs` currently records for a job, or undefined when
   * no row exists. Read after a guarded write is rejected, to tell a row that
   * contradicts the frame from one that already agrees with it.
   */
  private async readJobStatus(runId: string, jobId: string): Promise<string | undefined> {
    const row = await this.db
      .selectFrom('execution_jobs')
      .select(['status'])
      .where('run_id', '=', runId)
      .where('job_id', '=', jobId)
      .executeTakeFirst();
    return row?.status;
  }

  /**
   * The status `execution_runs` currently records for a run, or undefined when
   * no row exists. Read on the agreeing-frame path to tell a run that still
   * needs driving from one that was already rolled up.
   */
  private async readRunStatus(runId: string): Promise<string | undefined> {
    const row = await this.db
      .selectFrom('execution_runs')
      .select(['status'])
      .where('run_id', '=', runId)
      .executeTakeFirst();
    return row?.status;
  }

  /**
   * Run `fn` while holding a per-run lock, serializing the run-mutating methods
   * (`onJobStatus`, `addJobsToRun`) so a status reply cannot interleave with the
   * synthetic→real job swap and wedge the run in `running`.
   *
   * The lock is **reentrant**: these paths re-enter a locked method in the same
   * async context for the same runId — onJobStatus → scheduler hook →
   * dispatchReadyJob → addJobsToRun; onJobStatus → enforceSchedulerInvariant →
   * onJobStatus; runSchedulerHook → onJobStatus (skip). A context already
   * holding the runId's lock (`heldRunLocks`) runs `fn` inline instead of
   * deadlocking; a concurrent caller (a separate WS message) is a different async
   * context and waits. Reentrant paths are all same-runId, so there is no
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
    jobs: TrackedJobRow[],
    dispatchedContexts?: string[],
    /** Synthetic job ID to replace (e.g. needs-pending-deploy-{uuid}). */
    replaceSyntheticId?: string,
  ): Promise<void> {
    // Serialize the synthetic→real swap against a concurrent onJobStatus;
    // reentrant from a locked onJobStatus (the scheduler-hook dispatch path).
    return this.withRunLock(runId, () =>
      this.addJobsToRunImpl(runId, jobs, dispatchedContexts, replaceSyntheticId),
    );
  }

  private async addJobsToRunImpl(
    runId: string,
    jobs: TrackedJobRow[],
    dispatchedContexts?: string[],
    replaceSyntheticId?: string,
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      logger.warn('addJobsToRun: run not found in memory', { runId });
      return;
    }

    // A caller that knows no workflow (a needs-gated release, an invoke gate)
    // inherits it from the placeholder the job replaces.
    if (replaceSyntheticId) {
      const inherited = await this.placeholderWorkflowName(run, runId, replaceSyntheticId);
      if (inherited) jobs = jobsOfWorkflow(inherited, jobs);
    }

    // Cluster correctness: the synthetic row may be in the shared DB but not in
    // this peer's run.jobs (the ingesting peer inserted it; this peer got only
    // the rerouted upstream job), so the DB delete is unconditional.
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

    // A fast agent (a mock or a no-op job) can report the new job's terminal
    // status before this swap lands; onJobStatus then recovered the real job
    // into run.jobs and the DB as terminal. Resetting it to `pending` would
    // leave the run stuck in `running` forever, so an already-terminal status
    // (in memory or in the DB row) is preserved.
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
        // The early update may have made the DB row terminal while run.jobs held
        // only the synthetic id, so consult the DB too.
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
        ...(job.workflowName && { workflowName: job.workflowName }),
        status,
        ...(preservedStartedAt !== undefined && { startedAt: preservedStartedAt }),
        ...(preservedAgentId !== undefined && { agentId: preservedAgentId }),
        ...(job.runsOnLabels?.length && { runsOnLabels: job.runsOnLabels }),
        ...(job.contexts?.length && { contexts: job.contexts }),
      });
    }

    await this.insertTrackedJobRows(runId, run.routingKey ?? null, dispatchedContexts, jobs);

    for (const job of jobs) {
      this.writeOrchLog(runId, job.jobId, OrchLogPhase.enum.dispatch, 'Job dispatched to queue');
    }

    // Forward the new job count at the unchanged run status.
    this.onExecutionStatusChange?.(
      runId,
      run.status,
      {
        ...runSummaryFields(run),
        ...(run.localWorkingTree && { localWorkingTree: true }),
      },
      run.jobs.size,
      run.startedAt,
    );

    // Re-check completion when a just-added job is already terminal: the early
    // status update's own check was blocked by the synthetic placeholder this
    // swap just removed, and no further job.status is coming for a finished
    // job. Without this the run hangs in `running` forever.
    if (reEvaluateCompletion.size > 0 && !run.completedAt && this.isRunComplete(runId)) {
      const stopAfterStuckCheck = await this.enforceSchedulerInvariantOrFail(runId);
      if (!stopAfterStuckCheck && (await this.readyToFinalize(run, runId))) {
        await this.finalizeRunCompletion(run, runId, Date.now(), new Date());
      }
    }
  }

  /**
   * The workflow of the placeholder a job replaces: from memory, or from its
   * row when another peer registered it.
   */
  private async placeholderWorkflowName(
    run: RunState,
    runId: string,
    placeholderId: string,
  ): Promise<string | undefined> {
    const known = run.jobs.get(placeholderId)?.workflowName;
    if (known) return known;
    const row = await this.db
      .selectFrom('execution_jobs')
      .select('workflow_name')
      .where('run_id', '=', runId)
      .where('job_id', '=', placeholderId)
      .executeTakeFirst();
    return row?.workflow_name ?? undefined;
  }

  /** Mark a run as a test run for observer broadcasting (called by the test pipeline). */
  markTestRun(runId: string): void {
    this.testRunIds.add(runId);
  }

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
    // Serialize against a concurrent addJobsToRun swap; the in-context
    // recursions (enforceSchedulerInvariantOrFail / runSchedulerHook skip →
    // onJobStatus) re-enter inline (see withRunLock).
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

    // Rebuild missing in-memory state from the DB (e.g. failRun deleted it
    // before the agent picked up a queued job) so completion and Platform
    // forwarding still work.
    if (!run) {
      const recovered = await this.recoverRunFromDb(runId, jobId, state);
      if (!recovered) return;
      run = recovered;
    }

    if (run && !job) {
      job = await this.recoverJobFromDispatchQueue(run, runId, jobId);
    }

    // Idempotency: a replayed terminal status equal to the current one is a
    // no-op (re-applying double-notifies). It resolves normally, so an
    // ack-after-apply coordinator still acks and the worker prunes its outbox.
    if (job && job.status === state && TERMINAL_JOB_STATES.has(state)) {
      return;
    }

    // started_at only on the FIRST running message: build jobs send several
    // (deps_installed, bundle_compiled), which would give zero-width Gantt bars.
    const isFirstRunning = state === ExecutionJobStatus.enum.running && !job?.startedAt;
    const now = new Date(timestamp);

    // DB upsert first, then memory. The upsert is monotonic: a terminal row is
    // never rewritten, so a late agent frame cannot resurrect a reaped job. On
    // rejection the DB is the record, so memory and the terminal fan-out below
    // are skipped.
    const persisted = await this.persistJobStatusUpdate({
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
    if (!persisted.applied) {
      // An orchestrator-side writer may have reached the same verdict first (a
      // cancel sweep marking a dispatched job `cancelled`), leaving a row this
      // frame AGREES with. Suppressing the fan-out then strands the run: only an
      // agent frame drives completion here. Only a differing row contradicts.
      const storedStatus = await this.readJobStatus(runId, jobId);
      if (storedStatus !== state) {
        nonMonotonicJobStatusWritesTotal.add(1, { rejected_status: state });
        logger.warn('Job status write rejected: row already terminal', {
          runId,
          jobId,
          rejectedStatus: state,
          storedStatus,
          knownStatus: job?.status,
          agentId,
        });
        return;
      }
      // The row agrees — but drive only a run that still needs it. An outbox
      // replay after the run was pruned rehydrates a run with `completedAt`
      // unset, which would roll it up again: a duplicate provider check and a
      // second terminal status the Platform never revisits. The run row decides.
      const runStatus = await this.readRunStatus(runId);
      if (runStatus !== undefined && TERMINAL_RUN_STATES.has(runStatus)) {
        logger.debug('Job status write already recorded; run already terminal', {
          runId,
          jobId,
          status: state,
          runStatus,
        });
        this.releaseRunFinishedElsewhere(runId);
        return;
      }
      logger.debug('Job status write already recorded by an orchestrator-side writer', {
        runId,
        jobId,
        status: state,
      });
    }
    await this.reopenRecoveredRun(run, runId);
    const jobLogBytesTotal = persisted.jobLogBytesTotal;

    if (job) {
      job.status = state;
      if (isFirstRunning) {
        job.startedAt = timestamp;
      }
      if (agentId && !job.agentId) {
        job.agentId = agentId;
      }
    }

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

    // Observers see test runs only.
    if (this.observerRegistry && this.testRunIds.has(runId) && job) {
      this.observerRegistry.broadcastStatus(runId, state, job.name);
    }

    if (TERMINAL_JOB_STATES.has(state)) {
      await this.reconcileOrphanedSteps(runId, jobId, state, now);
    }

    if (TERMINAL_JOB_STATES.has(state) && run && job) {
      this.onJobComplete?.({
        runId,
        jobId,
        jobName: job.name,
        status: state,
        routingKey: run.routingKey,
        repo: run.repoIdentifier,
        workflowName: run.workflowName,
        data,
      });
    }

    if (TERMINAL_JOB_STATES.has(state) && data?.droppedJobs && Array.isArray(data.droppedJobs)) {
      await this.handleDriftDroppedJobs(runId, data.droppedJobs as string[]);
    }

    if (TERMINAL_JOB_STATES.has(state) && job) {
      await this.runSchedulerHook(runId, jobId, job.name, state);
      await this.runWaveSchedulerHook(runId, jobId, state);
      await this.runInvokeGateAggregationHook(runId, jobId);
    }

    // Completion check with stuck-jobs enforcement. The `completedAt` guard
    // keeps finalization idempotent: a late update must not roll the run up a
    // second time (duplicate provider check, second terminal run status).
    if (TERMINAL_JOB_STATES.has(state) && run && !run.completedAt && this.isRunComplete(runId)) {
      const stopAfterStuckCheck = await this.enforceSchedulerInvariantOrFail(runId);
      if (stopAfterStuckCheck) return;
    }

    if (TERMINAL_JOB_STATES.has(state) && run && (await this.readyToFinalize(run, runId))) {
      await this.finalizeRunCompletion(run, runId, timestamp, now);
    }
  }

  /**
   * Whether this coordinator may finalize the run now.
   *
   * The in-memory map is only this coordinator's view: a rehydrated run holds
   * just the jobs its own agents reported, and even the owner holds a
   * sibling-claimed job at its last-heard status. So once the map reads
   * complete, the shared `execution_jobs` rows are folded in
   * ({@link syncRunJobsFromRows}) and the check repeats over every job — a job a
   * sibling still runs keeps the run open.
   *
   * Then the registration window: while a LIVE sibling still has jobs to
   * register (a build-window owner dispatches its real jobs after the build),
   * finalization defers to whichever coordinator sees the last job finish, or
   * to that owner's release, which re-runs this check. A dead holder reads as no
   * window; the stale detector's all-terminal sweep finishes its run.
   */
  private async readyToFinalize(run: RunState, runId: string): Promise<boolean> {
    if (run.completedAt || !this.isRunComplete(runId)) return false;
    await this.syncRunJobsFromRows(run, runId);
    if (!this.isRunComplete(runId)) {
      logger.info('Run completion deferred: jobs owned by a sibling coordinator are not terminal', {
        runId,
      });
      return false;
    }
    return !(await this.registrationWindowHeldByLiveSibling(runId));
  }

  /**
   * Fold the run's `execution_jobs` rows into its in-memory map: an unknown row
   * is added at its status, and a non-terminal job is lifted to the row's
   * terminal status. Memory is never downgraded — the reported job's row is
   * upserted before any completion check, so a terminal memory entry is at
   * least as current as its row.
   */
  private async syncRunJobsFromRows(run: RunState, runId: string): Promise<void> {
    const rows = await this.db
      .selectFrom('execution_jobs')
      .select(['job_id', 'job_name', 'workflow_name', 'status'])
      .where('run_id', '=', runId)
      .execute();
    for (const row of rows) {
      if (typeof row.job_id !== 'string') continue;
      // The column is NOT NULL with a `pending` default; a row whose status
      // did not come back is still a job, and an unknown status is not terminal.
      const status = typeof row.status === 'string' ? row.status : ExecutionJobStatus.enum.pending;
      const known = run.jobs.get(row.job_id);
      if (!known) {
        run.jobs.set(row.job_id, {
          name: row.job_name ?? row.job_id,
          ...(row.workflow_name && { workflowName: row.workflow_name }),
          status,
        });
        continue;
      }
      if (!TERMINAL_JOB_STATES.has(known.status) && TERMINAL_JOB_STATES.has(status)) {
        known.status = status;
      }
    }
  }

  /**
   * Whether a live sibling coordinator has a registration window open on the
   * run — see {@link holdRunForPendingJobs}. This coordinator's own window is
   * governed by its in-memory token, so its own id reads as no sibling.
   */
  private async registrationWindowHeldByLiveSibling(runId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('execution_runs')
      .select(['registration_window_instance_id'])
      .where('run_id', '=', runId)
      .executeTakeFirst();
    const holder = row?.registration_window_instance_id;
    if (typeof holder !== 'string' || holder.length === 0) return false;
    if (holder === this.instanceId) return false;
    const live = await liveInstanceIds(this.db, [holder], this.livenessGraceMs);
    if (!live.has(holder)) return false;
    logger.info('Run completion deferred: a sibling coordinator is still registering jobs', {
      runId,
      holder,
    });
    return true;
  }

  /**
   * Phase 1a: recover run state from the DB when in-memory tracking is empty.
   * Null when the run is unknown to the DB; the caller then skips the update.
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
        'triggered_by_agent_label',
        'trigger_actor_username',
        'trigger_actor_user_id',
        'check_mode',
        'local_working_tree',
        'workflow_repo_identifier',
        'trust_tier',
        'lock_file_source',
        'failure_reason',
        'status_epoch',
      ])
      .where('run_id', '=', runId)
      .executeTakeFirst();

    if (!dbRun) {
      // Cleaned up (e.g. warm-start purge): nothing to track.
      logger.warn('Run not found in DB, skipping job status update', { runId, jobId, state });
      return null;
    }

    if (dbRun.workflow_name.startsWith(ROUND_JOB_PREFIX)) {
      // A pre-run global eval round is never a run: its id only correlates the
      // queue row and, on failure, the errored row
      // `recordGlobalEvalRoundFailureRun` writes. Rehydrating would undo that
      // record — the reopen clears a non-build failure back to `running`, and the
      // round runner reports `success` even when it decided nothing, so the round
      // would roll up as a success contradicting the failing check on the same
      // commit. Nothing downstream tracks a round as a run.
      logger.warn('Run id belongs to a global eval round, skipping job status update', {
        runId,
        jobId,
        state,
      });
      return null;
    }

    if (dbRun.status === ExecutionRunStatus.enum.held) {
      // A held run is paused at the install gate and tracks no jobs; it resumes
      // into a fresh dispatch. Rehydrating it would let a late status from the
      // pre-hold dispatch roll it up as complete while it is still waiting.
      logger.warn('Run is held, skipping job status update', { runId, jobId, state });
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
      ...(dbRun.workflow_repo_identifier && {
        workflowRepoIdentifier: dbRun.workflow_repo_identifier,
      }),
      sha: dbRun.sha,
      ...(dbRun.local_working_tree === true && { localWorkingTree: true }),
      installationId,
      requestId: undefined,
      routingKey: dbRun.routing_key ?? undefined,
      ref: dbRun.ref,
      triggerEvent: undefined,
      commitMessage: undefined,
      parentRunId: dbRun.parent_run_id ?? undefined,
      originalRunId: dbRun.original_run_id ?? undefined,
      triggeredBy: dbRun.triggered_by ?? undefined,
      triggeredByAgentLabel: dbRun.triggered_by_agent_label ?? undefined,
      triggerActorUsername: dbRun.trigger_actor_username ?? undefined,
      triggerActorUserId: dbRun.trigger_actor_user_id ?? undefined,
      ...(dbRun.check_mode != null && { checkMode: dbRun.check_mode }),
      // Without the trust posture, a job completing after a coordinator restart
      // drops the reduced-privilege note its siblings' check summaries carry.
      ...(dbRun.trust_tier != null && { trustTier: dbRun.trust_tier }),
      ...(dbRun.lock_file_source != null && { lockFileSource: dbRun.lock_file_source }),
      ...(recoveredDriftDetected && { driftDetected: true }),
      ...(dbRun.status_epoch ? { statusEpoch: dbRun.status_epoch } : {}),
      ...(isReopenableFailure(dbRun.status, dbRun.failure_reason) && {
        reopenableFailedRow: true,
      }),
      jobs: new Map(),
      startedAt: new Date(dbRun.started_at).getTime(),
    };
    this.runs.set(runId, recoveredRun);

    logger.info('Recovered in-memory run state from DB', { runId });

    return recoveredRun;
  }

  /**
   * Reopen a run rehydrated from a prematurely `failed` row (e.g. "No agents
   * available to dispatch jobs", but a queued job is now running): reset the
   * row to `running`, clear the failure it recorded, and raise its status
   * generation; run completion then sets the final status.
   *
   * Called only after the rehydrating job report is applied to its job row: a
   * replay of a frame the row already records must not reopen (and roll up
   * again) a finished run. A build failure is intentionally terminal and is
   * never reopened.
   */
  private async reopenRecoveredRun(run: RunState, runId: string): Promise<void> {
    if (!run.reopenableFailedRow) return;
    run.reopenableFailedRow = false;
    const nextEpoch = (run.statusEpoch ?? 0) + 1;
    const result = await this.db
      .updateTable('execution_runs')
      .set({
        status: ExecutionRunStatus.enum.running,
        completed_at: null,
        duration_ms: null,
        // fails-when: a reopened run keeps the failure it left, and shows it while it runs
        // breaks-if-wrong: the build-failure predicate below still reads the reason before it clears
        failure_reason: null,
        failure_class: null,
        status_epoch: nextEpoch,
      })
      .where('run_id', '=', runId)
      .where('status', '=', ExecutionRunStatus.enum.failed)
      // fails-when: two reopens of one generation both raise the epoch.
      // breaks-if-wrong: the first reopen of a failed run must still raise it.
      .where('status_epoch', '=', run.statusEpoch ?? 0)
      .where((eb) =>
        eb.or([
          eb('failure_reason', 'is', null),
          eb(sql`lower(failure_reason)`, 'not like', '%build%'),
        ]),
      )
      .executeTakeFirst();
    if (Number(result?.numUpdatedRows ?? 0n) > 0) {
      run.statusEpoch = nextEpoch;
      logger.info('Reopened a prematurely failed run', { runId, statusEpoch: nextEpoch });
      return;
    }
    await this.adoptStoredStatusEpoch(run, runId);
  }

  /**
   * Read the run row's status generation into the in-memory run after this
   * coordinator's reopen matched nothing.
   *
   * The reopen loses when another coordinator reopened the run first, or when
   * this view is a generation behind. Either way the row's generation is
   * current: keeping an older value would send every later frame at a
   * generation the Platform treats as older, so none would apply.
   */
  private async adoptStoredStatusEpoch(run: RunState, runId: string): Promise<void> {
    const row = await this.db
      .selectFrom('execution_runs')
      .select('status_epoch')
      .where('run_id', '=', runId)
      .executeTakeFirst();
    // fails-when: the losing coordinator keeps generation 0 after the winner raised the row to 1
    // breaks-if-wrong: a run row that no longer exists leaves the in-memory generation as it was
    if (row) run.statusEpoch = row.status_epoch;
  }

  /**
   * Phase 1b: recover job state from the dispatch_queue into the run's
   * in-memory map.
   */
  private async recoverJobFromDispatchQueue(
    run: RunState,
    runId: string,
    jobId: string,
  ): Promise<RunState['jobs'] extends Map<string, infer V> ? V : never> {
    // Reuse an existing entry (e.g. from an addJobsToRun swap, maybe terminal):
    // a fresh `pending` object would orphan the one onJobStatus is about to
    // mutate and wedge the run in `running`. The per-run lock already prevents
    // the interleave; this removes the footgun outright.
    const existing = run.jobs.get(jobId);
    if (existing) {
      return existing;
    }

    const queueEntry = await this.db
      .selectFrom('dispatch_queue')
      .select(['job_name', 'workflow_name'])
      .where('id', '=', jobId)
      .executeTakeFirst();

    const jobName = queueEntry?.job_name ?? jobId;
    run.jobs.set(jobId, {
      name: jobName,
      ...(queueEntry?.workflow_name && { workflowName: queueEntry.workflow_name }),
      status: ExecutionJobStatus.enum.pending,
    } as any);
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
   *
   * The conflict update cannot rewrite a terminal row; `applied` reports the
   * guard's verdict. The log byte total is set on a terminal state and feeds
   * run.log_bytes at run completion.
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
  }): Promise<{ applied: boolean; jobLogBytesTotal: number | undefined }> {
    const { runId, jobId, state, timestamp, agentId, data, run, job, now, isFirstRunning } = opts;

    // Upsert, not UPDATE: the row may never have been inserted (e.g. failRun
    // ran before addJobsToRun because no agents were available, but the queued
    // job was later picked up).
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
      // Duration from job start, not run start.
      if (job?.startedAt) {
        // Rewrite started_at too: the first running message's write may have
        // missed a row onExecutionStarted had not inserted yet.
        updateValues.started_at = new Date(job.startedAt);
        updateValues.duration_ms = timestamp - job.startedAt;
      }
      if (data?.error) {
        updateValues.error_message = errorText(data.error);
      }
      // Init failure of a synthetic rejected-* / init-failed-* job that never
      // started; survives restart and feeds the dashboard logs view.
      if (data?.initFailure) {
        updateValues.init_failure = JSON.stringify(data.initFailure);
      }
      // Outputs for cross-job transport and dashboard display.
      if (data?.outputs) {
        updateValues.outputs = JSON.stringify(data.outputs);
      }
      // The precursor payload (build / init / dynamic-eval markers and results)
      // lets a sibling coordinator awaiting this job settle from the shared row:
      // the agent reports to the coordinator it is connected to, not always the
      // dispatching one.
      const precursorResult = extractPrecursorResult(data);
      if (precursorResult) {
        updateValues.precursor_result = JSON.stringify(precursorResult);
      }
      // 0 when no step reported (failed before any step, or an older agent
      // without logBytesStreamed) — the column is NOT NULL DEFAULT 0.
      jobLogBytesTotal = this.jobLogBytes.get(runId)?.get(jobId) ?? 0;
      updateValues.log_bytes = jobLogBytesTotal;
    }

    // job_name for the INSERT half, when the row does not exist yet.
    const jobName = job?.name ?? jobId;

    const applied = await this.db
      .insertInto('execution_jobs')
      .values({
        run_id: runId,
        job_id: jobId,
        job_name: jobName,
        ...(job?.workflowName && { workflow_name: job.workflowName }),
        // Denormalized (migration 006); set by onExecutionStarted or copied from
        // execution_runs by the DB-recovery branch.
        routing_key: run?.routingKey ?? null,
        ...updateValues,
      })
      // The guard makes every orchestrator-side verdict stick: after a reaper
      // writes a terminal status, an agent that never learned of it keeps
      // streaming, and an unguarded upsert would let a later `running` or
      // `completed` frame overwrite the verdict (with `completed_at` already
      // set), making the DB state depend on frame ordering. Every
      // orchestrator-side writer guards its own write (`markFailedIfRecovering`,
      // `markCompleted`, `sweepExpiredRecoveries`, the stale detector), so no
      // terminal-to-terminal correction passes through here.
      .onConflict((oc) =>
        oc
          .columns(['run_id', 'job_id'])
          .doUpdateSet(updateValues)
          .where('execution_jobs.status', 'not in', [...TERMINAL_JOB_STATES]),
      )
      .executeTakeFirst();

    return { applied: guardedWriteApplied(applied), jobLogBytesTotal };
  }

  /**
   * Phase 3a: pending -> running when the first job starts.
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
      runSummaryFields(run),
      run.jobs.size,
      run.startedAt,
    );
  }

  /**
   * Phase 3b: an agent's 'cancelling' (graceful cancel in progress, hooks
   * running) moves the run to 'cancelling' too.
   */
  private async maybeTransitionRunToCancelling(
    run: RunState | undefined,
    runId: string,
    state: string,
  ): Promise<void> {
    if (state !== ExecutionJobStatus.enum.cancelling || !run) return;

    // Read the DB status, not memory, to avoid races.
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
      // `cancelling_at` starts the stuck-cancelling re-drive clock; stamped in
      // the same guarded UPDATE so it never disagrees with the status.
      .set({ status: ExecutionRunStatus.enum.cancelling, cancelling_at: new Date() })
      .where('run_id', '=', runId)
      .where('status', 'in', [ExecutionRunStatus.enum.running, ExecutionRunStatus.enum.pending])
      .execute();

    run.status = ExecutionRunStatus.enum.cancelling;
    logger.info('Run transitioned to cancelling', { runId });

    this.onExecutionStatusChange?.(
      runId,
      ExecutionRunStatus.enum.cancelling,
      runSummaryFields(run),
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
      if (agentId) {
        this.emitRunEvent(runId, 'orchestrator.agent.assigned', {
          jobId,
          metadata: { agentId, jobName: job.name },
        });
        this.writeOrchLog(runId, jobId, OrchLogPhase.enum.setup, `Agent ${agentId} assigned`);
      }
      this.emitRunEvent(runId, 'orchestrator.job.started', {
        jobId,
        metadata: { agentId, jobName: job.name },
      });
      this.writeOrchLog(
        runId,
        jobId,
        OrchLogPhase.enum.setup,
        `Job execution started on agent ${agentId ?? 'unknown'}`,
      );
    } else if (TERMINAL_JOB_STATES.has(state) && job) {
      const jobDuration = job.startedAt ? timestamp - job.startedAt : undefined;
      this.emitRunEvent(runId, 'orchestrator.job.completed', {
        jobId,
        durationMs: jobDuration,
        metadata: { status: state, agentId },
      });
      this.writeOrchLog(
        runId,
        jobId,
        OrchLogPhase.enum.teardown,
        `Job completed with status ${state}`,
      );
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
    // Duration from job start, not run start.
    const duration = isTerminal && job.startedAt ? timestamp - job.startedAt : undefined;
    const errorMsg = isTerminal && data?.error ? errorText(data.error) : undefined;
    // Set for synthetic rejected-* / init-failed-* jobs.
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
      // Set only on a terminal job state.
      jobLogBytesTotal,
      initFailure,
      job.contexts,
      job.workflowName,
    );
  }

  /**
   * Phase 6: reconcile orphaned steps. Steps still 'running' when their job
   * is terminal (a lost step.complete IPC message) take the job's terminal
   * state; otherwise the dashboard shows the step running forever.
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
   * Phase 7: drift report handling. Jobs an agent reports as droppedJobs move
   * to the terminal drift_dropped, so the scheduler hook (Phase 8) propagates
   * failure to their downstreams.
   */
  private async handleDriftDroppedJobs(runId: string, droppedJobs: string[]): Promise<void> {
    for (const droppedJobName of droppedJobs) {
      try {
        // onJobStatus takes the job_id UUID, not the job name.
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
   * Phase 8: needs-aware scheduler hook: evaluate a terminal job's downstreams
   * for dispatch. The DAG is acyclic (validated at compile time L1 and eval
   * time L2), so recursive skip propagation terminates.
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
          // Failure propagation; onJobStatus takes the job_id UUID, not the name.
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
          // The processor does the actual dispatch.
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
   * a bounded wave (`maxParallel` set) reaches terminal, and performs what
   * {@link evaluateWave} decides:
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
      // Fan-out children only; evaluateWave noops for an unbounded wave.
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
        // dispatchReadyJob → addJobsToRun replaces the synthetic row with one
        // lacking the fan-out columns, so re-stamp them; otherwise this child's
        // own terminal reads a null base and the wave stalls after one release.
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
          // Ungate, then skip (mirrors the needs-scheduler skip path).
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
   * When a proxy job of an invoke gate reaches terminal, aggregate the gate once
   * every sibling proxy is terminal: `failed` if any proxy failed, else
   * `success`. The terminal gate releases its downstream `needs` through the
   * scheduler hook. A no-op for any non-proxy job.
   */
  private async runInvokeGateAggregationHook(runId: string, jobId: string): Promise<void> {
    try {
      const row = await this.db
        .selectFrom('execution_jobs')
        .select(['job_kind', 'base_job_name'])
        .where('run_id', '=', runId)
        .where('job_id', '=', jobId)
        .executeTakeFirst();
      if (row?.job_kind !== JobKind.Proxy || !row.base_job_name) return;

      const gateName = row.base_job_name;
      const siblings = await this.db
        .selectFrom('execution_jobs')
        .select('status')
        .where('run_id', '=', runId)
        .where('base_job_name', '=', gateName)
        .where('job_kind', '=', JobKind.Proxy)
        .execute();
      const aggregate = aggregateGateStatus(siblings.map((s) => s.status));
      if (!aggregate.allTerminal || !aggregate.status) return;

      const gate = await this.db
        .selectFrom('execution_jobs')
        .select(['job_id', 'status'])
        .where('run_id', '=', runId)
        .where('job_name', '=', gateName)
        .where('job_kind', '=', JobKind.Gate)
        .executeTakeFirst();
      if (!gate || TERMINAL_JOB_STATES.has(gate.status)) return;

      await this.onJobStatus(runId, gate.job_id, aggregate.status, Date.now());
    } catch (e) {
      logger.error('Invoke-gate aggregation hook failed', { runId, jobId, error: e });
    }
  }

  /**
   * Phase 9: stuck-jobs invariant check (Layer 3), before declaring a run
   * complete. Stuck jobs are failed via recursive onJobStatus calls, which
   * re-check completion with fresh state; true tells the caller to stop.
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
      // The recursive calls re-checked completion; do not proceed on stale state.
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

    const startedAt = run.startedAt;
    const durationMs = timestamp - startedAt;

    const failureReason =
      overallStatus === ExecutionRunStatus.enum.failed
        ? this.buildRunDescription(run, overallStatus)
        : undefined;
    if (failureReason) {
      run.failureReason = failureReason;
    }

    // Sum of per-job log bytes; 0 with no per-job entries (e.g. every job
    // failed before a step ran).
    let runLogBytesTotal = 0;
    const perJob = this.jobLogBytes.get(runId);
    if (perJob) {
      for (const v of perJob.values()) runLogBytesTotal += v;
    }

    // failure_reason write policy:
    //  - success: clear any stale reason (e.g. "No agents available" from a
    //    premature failRun that was recovered when the agent started).
    //  - failed: write the computed reason.
    //  - cancelled / other: omit the column, keeping a reason the cancel path
    //    stamped (user cancel, or cancelRunWithReason's workflow_timeout), so
    //    the dashboard can label the run "timed out" rather than cancelled.
    const failureReasonUpdate: { failure_reason?: string | null } =
      overallStatus === ExecutionRunStatus.enum.success
        ? { failure_reason: null }
        : failureReason !== undefined
          ? { failure_reason: failureReason }
          : {};

    const failureClass = this.computeFailureClass(overallStatus, [...run.jobs.values()]);

    // Monotonic: a row another writer already finished (a sibling coordinator,
    // the build-failure path, a cancel) keeps its verdict. The in-memory
    // fan-out below still runs: it drains this coordinator's own log buffers
    // and sheds its own run state, which no other writer can do.
    const terminalWrite = await this.db
      .updateTable('execution_runs')
      .set({
        status: overallStatus,
        completed_at: now,
        duration_ms: durationMs,
        log_bytes: runLogBytesTotal,
        failure_class: failureClass,
        ...failureReasonUpdate,
      })
      .where('run_id', '=', runId)
      .where('status', 'not in', [...TERMINAL_RUN_STATES])
      .executeTakeFirst();
    if (!guardedWriteApplied(terminalWrite)) {
      logger.warn('Run terminal write rejected: row already terminal', {
        runId,
        rejectedStatus: overallStatus,
      });
    }

    executionsTotal.add(1, { status: overallStatus });
    executionDurationSeconds.record(durationMs / 1000);

    logger.info('Execution completed', {
      runId,
      status: overallStatus,
      durationMs,
      logBytes: runLogBytesTotal,
    });

    const description = this.buildRunDescription(run, overallStatus);
    this.onExecutionComplete?.(
      runId,
      overallStatus,
      {
        workflowName: run.workflowName,
        provider: run.provider,
        repoIdentifier: run.repoIdentifier,
        ...(run.workflowRepoIdentifier && { workflowRepoIdentifier: run.workflowRepoIdentifier }),
        sha: run.sha,
        installationId: run.installationId,
        requestId: run.requestId,
        routingKey: run.routingKey,
      },
      description,
    );

    this.onExecutionStatusChange?.(
      runId,
      overallStatus,
      {
        ...runSummaryFields(run),
        failureClass,
      },
      run.jobs.size,
      startedAt,
      timestamp,
      durationMs,
      failureReason,
      runLogBytesTotal,
    );

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
      ...(failureClass && { failureClass }),
    });

    // Observers see test runs only.
    if (this.observerRegistry && this.testRunIds.has(runId)) {
      this.observerRegistry.broadcastComplete(runId, overallStatus, {
        totalDurationMs: durationMs,
        jobs: jobResults,
      });
    }

    // Best-effort: a failed mirror onto an invoke gate's proxy must not break
    // run completion.
    await this.mirrorSummonedRunOntoProxy(runId, overallStatus, timestamp).catch((err) => {
      logger.error('Failed to mirror summoned run onto its invoke-gate proxy', {
        runId,
        error: toErrorMessage(err),
      });
    });

    this.scheduleRunPrune(runId);
  }

  /**
   * The terminal job status a proxy carries for a terminal run status:
   * `success` and `cancelled` map through; every other status is `failed`.
   */
  private mapRunStatusToProxyStatus(runStatus: string): ExecutionJobStatus {
    if (runStatus === ExecutionRunStatus.enum.success) return ExecutionJobStatus.enum.success;
    if (runStatus === ExecutionRunStatus.enum.cancelled) return ExecutionJobStatus.enum.cancelled;
    return ExecutionJobStatus.enum.failed;
  }

  /**
   * Read a summoned run's non-secret declared outputs — the merged `outputs`
   * JSONB of its jobs. Secret-masked outputs live in `run_secret_outputs` and
   * are deliberately NOT read here, so a repo's secret output never crosses into
   * the summoning global run.
   */
  private async readNonSecretRunOutputs(spawnedRunId: string): Promise<Record<string, unknown>> {
    const rows = await this.db
      .selectFrom('execution_jobs')
      .select('outputs')
      .where('run_id', '=', spawnedRunId)
      .execute();
    const merged: Record<string, unknown> = {};
    for (const row of rows) {
      // JSONB may come back parsed; `JSON.parse` on that object throws and would
      // silently drop the outputs (see parseOutputsCell).
      const parsed = this.parseOutputsCell(row.outputs);
      if (parsed) Object.assign(merged, parsed);
    }
    return merged;
  }

  /**
   * Normalize an `outputs` JSONB cell (already-parsed object or JSON string)
   * to a plain object; `null` for a null / empty / malformed cell.
   */
  private parseOutputsCell(outputs: unknown): Record<string, unknown> | null {
    if (!outputs) return null;
    try {
      const parsed = typeof outputs === 'string' ? JSON.parse(outputs) : outputs;
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
    return null;
  }

  /**
   * When `spawnedRunId` was summoned by an invoke gate, set the gate's proxy job
   * to the run's mapped terminal status and attach its non-secret outputs. The
   * proxy's terminal transition drives the summoning run's scheduler (release the
   * next held proxy, and aggregate the gate once every proxy is terminal).
   */
  private async mirrorSummonedRunOntoProxy(
    spawnedRunId: string,
    runStatus: string,
    timestamp: number,
  ): Promise<void> {
    const runRow = await this.db
      .selectFrom('execution_runs')
      .select(['summoned_by_run_id', 'summoned_by_proxy_job', 'started_at', 'completed_at'])
      .where('run_id', '=', spawnedRunId)
      .executeTakeFirst();
    if (!runRow?.summoned_by_run_id || !runRow.summoned_by_proxy_job) return;

    const summoningRunId = runRow.summoned_by_run_id;
    const proxyRow = await this.db
      .selectFrom('execution_jobs')
      .select('job_id')
      .where('run_id', '=', summoningRunId)
      .where('job_name', '=', runRow.summoned_by_proxy_job)
      .where('job_kind', '=', JobKind.Proxy)
      .executeTakeFirst();
    if (!proxyRow) {
      logger.warn('Summoned run has no matching proxy job', {
        spawnedRunId,
        summoningRunId,
        proxyJobName: runRow.summoned_by_proxy_job,
      });
      return;
    }

    const outputs = await this.readNonSecretRunOutputs(spawnedRunId);
    await this.onJobStatus(
      summoningRunId,
      proxyRow.job_id,
      this.mapRunStatusToProxyStatus(runStatus),
      timestamp,
      undefined,
      Object.keys(outputs).length > 0 ? { outputs } : undefined,
    );

    // A proxy never sends `running`, so onJobStatus leaves started_at /
    // duration_ms null (a zero-width timeline row). Mirror the summoned run's
    // span so the proxy's bar matches the run it stands in for.
    await this.mirrorSummonedRunSpanOntoProxy(
      summoningRunId,
      proxyRow.job_id,
      runRow.started_at,
      runRow.completed_at,
      timestamp,
    );
  }

  /**
   * Set a proxy job's timeline span to the summoned run's started_at /
   * completed_at. A run rejected before any step has no start, so it falls back
   * to its completion (or, with none recorded, the mirror timestamp) and still
   * renders a point-width bar.
   */
  private async mirrorSummonedRunSpanOntoProxy(
    summoningRunId: string,
    proxyJobId: string,
    summonedStartedAt: Date | null,
    summonedCompletedAt: Date | null,
    fallbackCompletedAt: number,
  ): Promise<void> {
    const completedAt = summonedCompletedAt ?? new Date(fallbackCompletedAt);
    const startedAt = summonedStartedAt ?? completedAt;
    await this.db
      .updateTable('execution_jobs')
      .set({
        started_at: startedAt,
        completed_at: completedAt,
        duration_ms: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      })
      .where('run_id', '=', summoningRunId)
      .where('job_id', '=', proxyJobId)
      .execute();
  }

  /**
   * Drive the proxy mirror now when a just-tagged summoned run is already
   * terminal. Closes the tag race: a run that finalizes before
   * `summoned_by_run_id` lands (a synchronous all-jobs-rejected completion, or
   * an HA peer finalizing first) reads a null tag and skips, so the gate hangs
   * until its timeout. The invoke gate calls this after tagging each spawned
   * run; the `onJobStatus` idempotency guard makes a double-fire a no-op.
   */
  async reconcileSummonedRunIfTerminal(spawnedRunId: string): Promise<void> {
    const row = await this.db
      .selectFrom('execution_runs')
      .select('status')
      .where('run_id', '=', spawnedRunId)
      .executeTakeFirst();
    if (!row || !TERMINAL_RUN_STATES.has(row.status)) return;
    await this.mirrorSummonedRunOntoProxy(spawnedRunId, row.status, Date.now());
  }

  /**
   * Mark a run failed when its build fails (timeout or error) after the
   * processor tracked it early via onExecutionStarted; otherwise the row stays
   * non-terminal.
   */
  async onBuildFailed(runId: string, initFailure?: InitFailure): Promise<void> {
    const now = new Date();

    const failureReason = initFailure?.message ?? 'Build job failed';

    // Cascades to execution_runs, execution_jobs and dispatch_queue. The run
    // write is monotonic: a run a sibling coordinator already finished keeps
    // its verdict when this coordinator's build wait times out afterwards.
    const runWrite = await this.db
      .updateTable('execution_runs')
      .set({
        status: ExecutionRunStatus.enum.failed,
        completed_at: now,
        failure_reason: failureReason,
        ...(initFailure && { init_failure: JSON.stringify(initFailure) }),
      })
      .where('run_id', '=', runId)
      .where('status', 'not in', [...TERMINAL_RUN_STATES])
      .executeTakeFirst();
    if (!guardedWriteApplied(runWrite)) {
      logger.warn('Build-failure run write rejected: row already terminal', { runId });
    }
    await this.clearRegistrationWindow(runId);

    await this.db
      .updateTable('execution_jobs')
      .set({
        status: ExecutionJobStatus.enum.failed,
        completed_at: now,
        error_message: failureReason,
        // A job leaving the queue has no routing reason; the read boundary
        // hides it (`visibleRoutingReason`), and clearing keeps the row honest.
        routing_reason: null,
      })
      .where('run_id', '=', runId)
      .where('status', 'in', [ExecutionJobStatus.enum.pending, ExecutionJobStatus.enum.queued])
      .execute();

    // Fails pending/recovering dispatch_queue entries.
    await this.jobQueue?.failByRunId(runId);

    const run = this.runs.get(runId);
    if (run) {
      const completedAt = now.getTime();
      this.onExecutionStatusChange?.(
        runId,
        ExecutionRunStatus.enum.failed,
        runSummaryFields(run),
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
   * Insert a minimal `failed` execution_runs row when the build timed out
   * before onExecutionStarted inserted one (buildJobTrackedEarly was false), so
   * the dashboard and run queries see the failure instead of a missing run.
   *
   * A pre-dispatch recording site that writes the row and returns. The row is
   * terminal, so no invoke gate reads its `chain_depth`; it is stamped as in
   * {@link ExecutionTracker.recordInitFailureRun}: this row is the run's ONLY
   * record, and a `0` claims it started the chain it died inside.
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
    /**
     * Internal-trigger provenance, one object rather than more positional
     * args. Shape matches `preDispatchRunProvenance` in
     * `dispatch-matched-workflow.ts`, the only caller.
     */
    provenance?: {
      chainDepth?: number;
      dispatchedByFailureLifecycle?: boolean;
      rerunLineage?: RerunLineage;
    },
  ): Promise<void> {
    const now = new Date();
    const reason = failureReason ?? 'Build job timed out before execution tracking started';

    const customerId = await this.resolveCustomerId(routingKey);
    await this.db
      .insertInto('execution_runs')
      .values({
        run_id: runId,
        routing_key: routingKey,
        customer_id: customerId,
        workflow_name: workflowName,
        provider,
        repo_identifier: repoIdentifier,
        ref,
        sha,
        delivery_id: deliveryId,
        trigger_decision: failureLifecycleTriggerDecision(provenance?.dispatchedByFailureLifecycle),
        provider_context: JSON.stringify(providerContext),
        started_at: now,
        completed_at: now,
        status: ExecutionRunStatus.enum.failed,
        failure_reason: reason,
        ...inheritedChainDepth(provenance?.chainDepth),
        ...rerunLineageColumns(provenance?.rerunLineage),
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
   * Write a `failed` execution_runs row (with the structured init_failure) for
   * an init failure, and stamp any in-memory run complete so the recorded failure
   * is the run's final word. Forwarded via onExecutionStatusChange to the Platform
   * projection.
   *
   * An existing row is overwritten while live (dispatch may have registered the
   * run before init failed) and left alone once terminal, so a finished run is
   * never rewritten as failed. When the guard leaves it alone, the failure
   * metric and Platform forward are suppressed too: this orchestrator did not
   * record the init failure, so it must not report one.
   *
   * Without this, the secret / install-secret / all-jobs-rejected early exits in
   * dispatch-matched-workflow leave no trace on the dashboard.
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
    /**
     * The repository that DEFINES the workflow this run was about to execute.
     * REQUIRED so a caller that omits it does not compile: a null marker means
     * "the workflow lives in this run's own repository", not "unknown", and the
     * defining-repository predicate reads it as fact.
     *
     * Narrowed to the differing case as in `onExecutionStarted`, so passing
     * `repoIdentifier` (the per-repository case) records nothing.
     */
    workflowRepoIdentifier: string;
    /**
     * Inherited invoke-chain depth for a run summoned by an invoke gate.
     *
     * Unlike a hold ({@link ExecutionTracker.recordRunHeld}), an init failure is
     * terminal and never fires a gate, so nothing reads it to bound recursion.
     * It is recorded because this row is the run's ONLY record, and a `0`
     * claims it started the chain it died inside.
     */
    chainDepth?: number;
    /**
     * True when a failure-lifecycle trigger dispatched this run, recorded as
     * the run's `trigger_decision` marker
     * (`EventRouter.isFailureLifecycleRun`).
     *
     * For consistency, not a live reader: this path emits no
     * `__workflow_complete`. The row then agrees with the one
     * {@link ExecutionTracker.recordRunHeld} writes for the same dispatch, and a
     * later emit here cannot silently re-open the self-retrigger loop.
     */
    dispatchedByFailureLifecycle?: boolean;
    /** Re-run lineage, when this run re-runs another. */
    rerunLineage?: RerunLineage;
  }): Promise<void> {
    const now = new Date();
    const customerId = await this.resolveCustomerId(args.routingKey);
    const crossRepoWorkflowRepo = crossRepoWorkflowRepoOf(args);
    const applied = await this.db
      .insertInto('execution_runs')
      .values({
        run_id: args.runId,
        routing_key: args.routingKey,
        customer_id: customerId,
        workflow_name: args.workflowName,
        provider: args.provider,
        repo_identifier: args.repoIdentifier,
        ref: args.ref,
        sha: args.sha,
        delivery_id: args.deliveryId,
        trigger_decision: failureLifecycleTriggerDecision(args.dispatchedByFailureLifecycle),
        provider_context: JSON.stringify(args.providerContext),
        started_at: now,
        completed_at: now,
        status: ExecutionRunStatus.enum.failed,
        failure_reason: args.initFailure.message,
        failure_class: RunFailureClass.enum.never_started,
        init_failure: JSON.stringify(args.initFailure),
        ...inheritedChainDepth(args.chainDepth),
        ...rerunLineageColumns(args.rerunLineage),
        ...(crossRepoWorkflowRepo && { workflow_repo_identifier: crossRepoWorkflowRepo }),
      })
      // Overwrite a non-terminal row: a `pending` row left untouched strands
      // the run mid-flight. The guard keeps a terminal row, so a finished run
      // is never rewritten as failed.
      .onConflict((oc) =>
        oc
          .column('run_id')
          .doUpdateSet({
            completed_at: now,
            // Measure from the conflicting row's real start, not the insert
            // path's zero duration.
            duration_ms: sql<number>`extract(epoch from (${now} - execution_runs.started_at)) * 1000`,
            status: ExecutionRunStatus.enum.failed,
            failure_reason: args.initFailure.message,
            failure_class: RunFailureClass.enum.never_started,
            init_failure: JSON.stringify(args.initFailure),
            // Restate the depth (only ever set, never cleared): a row from any
            // path but dispatch keeps the `0` default, which reads as "starts a
            // chain", not "unknown".
            //
            // `trigger_decision` is deliberately NOT restated: the conflicting
            // row came from `recordRunStart`, whose blob is the full decision
            // summary with the marker merged in, a superset of this path's
            // blob; `EventRouter.isFailureLifecycleRun` finds its key either way.
            ...inheritedChainDepth(args.chainDepth),
            // Restate the marker too (only ever set, never cleared): a row from
            // any path but `onExecutionStarted` keeps a null marker, read as
            // "the workflow lives in this run's own repository", not "unknown".
            ...(crossRepoWorkflowRepo && { workflow_repo_identifier: crossRepoWorkflowRepo }),
          })
          .where('execution_runs.status', 'not in', [...TERMINAL_RUN_STATES]),
      )
      .executeTakeFirst();

    // A kept terminal row means our record has no init failure, so neither the
    // metric nor the Platform forward may claim one (see `guardedWriteApplied`).
    if (!guardedWriteApplied(applied)) {
      logger.debug('Init-failure record skipped: run already terminal in DB', {
        runId: args.runId,
      });
      return;
    }

    executionsTotal.add(1, { status: ExecutionRunStatus.enum.failed });

    this.onExecutionStatusChange?.(
      args.runId,
      ExecutionRunStatus.enum.failed,
      {
        workflowName: args.workflowName,
        provider: args.provider,
        repoIdentifier: args.repoIdentifier,
        ...(crossRepoWorkflowRepo && { workflowRepoIdentifier: crossRepoWorkflowRepo }),
        sha: args.sha,
        routingKey: args.routingKey,
        ref: args.ref,
        triggerEvent: args.triggerEvent,
        commitMessage: args.commitMessage,
        failureClass: RunFailureClass.enum.never_started,
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

    // Stamp the in-memory run complete so a late job status cannot roll it up
    // over this failure. Not dropped: the next status would rehydrate it, and
    // rehydration resets a non-build failure to `running`. Pruned on the normal
    // delay so late traffic still finds the completed run.
    const memRun = this.runs.get(args.runId);
    if (memRun) {
      memRun.completedAt = now.getTime();
      this.scheduleRunPrune(args.runId);
    }
  }

  /**
   * Write one `failed` execution_runs row for a global eval round that never
   * produced verdicts.
   *
   * A failed round suppresses every organization-wide workflow it was deciding
   * on; without this row nothing on the dashboard explains their absence.
   *
   * **One row for the whole round, not one per workflow:** the round collapses
   * N candidate workflows into one pre-run job, and N rows would undo that. The
   * reason names every affected workflow instead.
   *
   * `runId` is the round job's (last attempt's) own, so the row, the
   * `dispatch_queue` row and the attempt's logs share one id. `doNothing` is
   * guard enough: the id was minted for this round and belongs to no other run.
   */
  async recordGlobalEvalRoundFailureRun(args: {
    runId: string;
    workflowName: string;
    provider: string;
    repoIdentifier: string;
    ref: string;
    sha: string;
    deliveryId: string | null;
    providerContext: Record<string, unknown>;
    routingKey: string;
    /**
     * The source `providerContext` was taken from, when a cross-provider
     * lock-file fallback made it a different source from `routingKey`.
     *
     * The two are a PAIR: a re-run re-drives the organization-wide pass with the
     * bundle those credentials belong to. Pairing the stored context with the
     * inbound routing key gives one source's credentials to another's API client.
     */
    dispatchRoutingKey?: string;
    failureReason: string;
    triggerEvent?: string;
    /**
     * The repository whose global workflows the round was deciding — normally
     * not `repoIdentifier`, and recorded only when the two differ.
     */
    workflowRepoIdentifier: string;
  }): Promise<void> {
    const now = new Date();
    const customerId = await this.resolveCustomerId(args.routingKey);
    const crossRepoWorkflowRepo = crossRepoWorkflowRepoOf(args);
    const applied = await this.db
      .insertInto('execution_runs')
      .values({
        run_id: args.runId,
        routing_key: args.routingKey,
        customer_id: customerId,
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
        failure_reason: args.failureReason,
        failure_class: RunFailureClass.enum.never_started,
        ...(crossRepoWorkflowRepo && { workflow_repo_identifier: crossRepoWorkflowRepo }),
        // Only when it differs from the inbound source (like
        // `workflow_repo_identifier`): NULL reads as "the event's own source".
        ...(args.dispatchRoutingKey != null &&
          args.dispatchRoutingKey !== args.routingKey && {
            dispatch_routing_key: args.dispatchRoutingKey,
          }),
        // The re-run path branches on this marker, not the `__globaleval__` name
        // prefix a customer workflow may also carry; this is the only writer of
        // a round's run row.
        is_global_eval_round: true,
      })
      .onConflict((oc) => oc.column('run_id').doNothing())
      .executeTakeFirst();

    if (!guardedWriteApplied(applied)) {
      logger.debug('Global eval round failure record skipped: run id already present', {
        runId: args.runId,
      });
      return;
    }

    executionsTotal.add(1, { status: ExecutionRunStatus.enum.failed });

    this.onExecutionStatusChange?.(
      args.runId,
      ExecutionRunStatus.enum.failed,
      {
        workflowName: args.workflowName,
        provider: args.provider,
        repoIdentifier: args.repoIdentifier,
        ...(crossRepoWorkflowRepo && { workflowRepoIdentifier: crossRepoWorkflowRepo }),
        isGlobalEvalRound: true,
        sha: args.sha,
        routingKey: args.routingKey,
        ref: args.ref,
        triggerEvent: args.triggerEvent,
        failureClass: RunFailureClass.enum.never_started,
      },
      0,
      now.getTime(),
      now.getTime(),
      0,
      args.failureReason,
      0,
    );

    logger.info('Recorded failed execution run for a global eval round', {
      runId: args.runId,
      workflowName: args.workflowName,
      reason: args.failureReason,
    });
  }

  /**
   * Record a run paused at the workflow install gate (a `registries:` /
   * `installEnv:` protection rule returned hold / wait / queue) as a resumable
   * `held` `execution_runs` row the dashboard run list shows. No jobs are
   * tracked: the caller's held_runs row and pending workflow context keep the
   * run from counting as complete, and any in-memory run is dropped so jobs
   * registered before the gate cannot roll it up.
   *
   * An existing row for this runId is flipped to `held` while it is still live
   * and left alone once it is terminal — a finished run is never re-held.
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
    contextName?: string;
    reason: string;
    triggerEvent?: string;
    commitMessage?: string;
    /**
     * Pull-request number for PR-triggered holds. PR-scoped
     * `/kici approve|reject` joins `execution_runs` on `pr_number`; a NULL
     * leaves a security hold fail-closed unreachable by the comment path.
     */
    prNumber?: number | null;
    /**
     * The repository that DEFINES the held workflow. REQUIRED as on
     * {@link ExecutionTracker.recordInitFailureRun}: a null marker would
     * misattribute the hold while it waits and the run it resumes into.
     */
    workflowRepoIdentifier: string;
    /** Workflow repository commit, recorded only for a cross-repository workflow. */
    workflowSha?: string | null;
    /** Workflow repository registered branch, recorded only for a cross-repository workflow. */
    workflowBranch?: string | null;
    /**
     * Inherited invoke-chain depth for a run summoned by an invoke gate. Any
     * caller that has one MUST thread it: the resumed run can fire its own
     * invoke gate, and the chain-depth circuit breaker reads this column back.
     * Absent ⇒ the `0` default, meaning "this run starts a chain".
     */
    chainDepth?: number;
    /**
     * True when a failure-lifecycle trigger dispatched this run, recorded as
     * the run's `trigger_decision` marker so its eventual completion is
     * excluded from batch accumulation (`EventRouter.isFailureLifecycleRun`).
     */
    dispatchedByFailureLifecycle?: boolean;
    /** Re-run lineage, when this run re-runs another. */
    rerunLineage?: RerunLineage;
    /**
     * True for a held pre-run global evaluation round: the marker the release
     * and re-run paths branch on.
     */
    isGlobalEvalRound?: boolean;
    /**
     * For a held evaluation round: the workflows it covers (in the
     * `trigger_decision` blob), so its release can refuse when one lost its
     * registration while the round waited.
     */
    heldRoundWorkflows?: readonly string[];
    /**
     * The source `providerContext` was taken from, when not `routingKey`; a held
     * round's release re-drives the organization-wide pass with that pair (see
     * {@link ExecutionTracker.recordGlobalEvalRoundFailureRun}).
     */
    dispatchRoutingKey?: string;
  }): Promise<void> {
    const now = new Date();
    // The resume reuses this row and onExecutionStarted's conflict path skips
    // customer_id, so the concurrency gate needs the real org here, not
    // '__default__'.
    const customerId = await this.resolveCustomerId(args.routingKey);
    const crossRepoProvenance = crossRepoProvenanceOf(args.repoIdentifier, {
      identifier: args.workflowRepoIdentifier,
      sha: args.workflowSha ?? null,
      branch: args.workflowBranch ?? null,
    });
    const crossRepoWorkflowRepo = crossRepoProvenance?.identifier;
    const written = await this.db
      .insertInto('execution_runs')
      .values({
        run_id: args.runId,
        routing_key: args.routingKey,
        customer_id: customerId,
        workflow_name: args.workflowName,
        provider: args.provider,
        repo_identifier: args.repoIdentifier,
        ref: args.ref,
        sha: args.sha,
        delivery_id: args.deliveryId,
        trigger_decision: heldRunTriggerDecision(args),
        provider_context: JSON.stringify(args.providerContext),
        started_at: now,
        status: ExecutionRunStatus.enum.held,
        ...(args.contextName && { context: args.contextName }),
        ...(args.prNumber != null && { pr_number: args.prNumber }),
        ...inheritedChainDepth(args.chainDepth),
        ...rerunLineageColumns(args.rerunLineage),
        ...(crossRepoProvenance && workflowProvenanceColumns(crossRepoProvenance)),
        ...(args.isGlobalEvalRound === true && { is_global_eval_round: true }),
        // NULL reads as "the source the event arrived on", as on the failed round.
        ...(args.dispatchRoutingKey != null &&
          args.dispatchRoutingKey !== args.routingKey && {
            dispatch_routing_key: args.dispatchRoutingKey,
          }),
      })
      // Overwrite a non-terminal row: an untouched `pending` row hides the hold
      // from the dashboard run list. A terminal row is kept: never re-held.
      .onConflict((oc) =>
        oc
          .column('run_id')
          .doUpdateSet({
            status: ExecutionRunStatus.enum.held,
            ...(args.contextName && { context: args.contextName }),
            ...(args.prNumber != null && { pr_number: args.prNumber }),
            // As on `recordInitFailureRun`: depth only ever set, and
            // `trigger_decision` left alone to keep `recordRunStart`'s superset.
            ...inheritedChainDepth(args.chainDepth),
            // As on `recordInitFailureRun`: the marker is only ever set. A hold
            // that does not know the commit and branch keeps the row's; one
            // that does replaces them.
            ...(crossRepoProvenance && {
              workflow_repo_identifier: crossRepoProvenance.identifier,
              workflow_sha: sql<
                string | null
              >`COALESCE(EXCLUDED.workflow_sha, execution_runs.workflow_sha)`,
              workflow_branch: sql<
                string | null
              >`COALESCE(EXCLUDED.workflow_branch, execution_runs.workflow_branch)`,
            }),
          })
          .where('execution_runs.status', 'not in', [...TERMINAL_RUN_STATES]),
      )
      .executeTakeFirst();

    // The guard kept a terminal row: the run finished and is not held. Tell the
    // Platform nothing — a `held` frame would move its finished run backwards.
    // fails-when: a hold on a finished run still forwards `held`.
    // breaks-if-wrong: a hold on a live run must still forward `held`.
    if (Number(written?.numInsertedOrUpdatedRows ?? 0n) === 0) {
      logger.warn('Held execution run not recorded: the run is already terminal', {
        runId: args.runId,
        workflowName: args.workflowName,
      });
      this.runs.delete(args.runId);
      return;
    }

    this.onExecutionStatusChange?.(
      args.runId,
      ExecutionRunStatus.enum.held,
      {
        workflowName: args.workflowName,
        provider: args.provider,
        repoIdentifier: args.repoIdentifier,
        ...(crossRepoWorkflowRepo && { workflowRepoIdentifier: crossRepoWorkflowRepo }),
        // Mirrored by the Platform, so its row reads as a round.
        ...(args.isGlobalEvalRound === true && { isGlobalEvalRound: true }),
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
      context: args.contextName,
      reason: args.reason,
    });

    // Drop the in-memory run: jobs registered before the gate could satisfy the
    // completion check and finalize a paused run. The resume is a fresh dispatch.
    this.runs.delete(args.runId);
  }

  /**
   * Claim a held global evaluation round for release (`held` → `pending`).
   * False when another release already claimed it, so a re-fired release
   * signal dispatches the round at most once.
   *
   * `pending` (as `resumeHeldRun`), not `running`: orphan recovery fails a
   * jobless `running` row older than its stale threshold, and a round row keeps
   * its hold's `started_at` and never has job rows. No sweeper selects a
   * jobless `pending` row with no workflow timeout.
   */
  async claimHeldGlobalEvalRound(runId: string): Promise<boolean> {
    const result = await this.db
      .updateTable('execution_runs')
      .set({ status: ExecutionRunStatus.enum.pending })
      .where('run_id', '=', runId)
      // fails-when: a second release signal claims a round the first one is running
      // breaks-if-wrong: the first release of a held round must still claim it
      .where('status', '=', ExecutionRunStatus.enum.held)
      .where('is_global_eval_round', '=', true)
      .executeTakeFirst();
    return Number(result?.numUpdatedRows ?? 0n) > 0;
  }

  /**
   * Terminalize a held global evaluation round whose hold was released.
   *
   * The released round runs as its own job and creates no run row, so nothing
   * else settles this row. `success` means it reached a verdict for its
   * workflow repository; `failed` that it did not, with the reason. Guarded on
   * `pending` (set by {@link ExecutionTracker.claimHeldGlobalEvalRound}), so
   * only the claiming release settles it.
   *
   * A settled round is not an execution: a success counts no
   * `executions_total` sample, and the frame carries `isGlobalEvalRound` so the
   * Platform raises no run notification or outbound webhook.
   */
  async completeReleasedGlobalEvalRound(
    runId: string,
    outcome:
      | { status: typeof ExecutionRunStatus.enum.success }
      | { status: typeof ExecutionRunStatus.enum.failed; reason: string },
  ): Promise<void> {
    const now = new Date();
    const failed = outcome.status === ExecutionRunStatus.enum.failed;
    const row = await this.db
      .updateTable('execution_runs')
      .set({
        status: outcome.status,
        completed_at: now,
        ...(failed && {
          failure_reason: outcome.reason,
          failure_class: RunFailureClass.enum.never_started,
        }),
      })
      .where('run_id', '=', runId)
      // fails-when: a release that did not claim the round settles it
      // breaks-if-wrong: the release that claimed the round must still settle it
      .where('status', '=', ExecutionRunStatus.enum.pending)
      .where('is_global_eval_round', '=', true)
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      logger.warn('completeReleasedGlobalEvalRound: no held round to settle', { runId });
      return;
    }
    // A failed round is counted like the failed round row the delivery writes.
    if (failed) executionsTotal.add(1, { status: outcome.status });
    this.onRunTerminalCleanup?.(runId);
    this.onExecutionStatusChange?.(
      runId,
      outcome.status,
      {
        workflowName: row.workflow_name,
        ...statusEpochField(row.status_epoch),
        provider: row.provider ?? '',
        repoIdentifier: row.repo_identifier ?? '',
        ...(row.workflow_repo_identifier && {
          workflowRepoIdentifier: row.workflow_repo_identifier,
        }),
        isGlobalEvalRound: true,
        sha: row.sha ?? '',
        routingKey: row.routing_key ?? undefined,
        ref: row.ref ?? '',
        ...(failed && { failureClass: RunFailureClass.enum.never_started }),
      },
      0,
      row.started_at ? new Date(row.started_at).getTime() : now.getTime(),
      now.getTime(),
      0,
      failed ? outcome.reason : undefined,
    );
    logger.info('Settled a released global eval round', { runId, status: outcome.status });
  }

  /**
   * Flip a `held` run back to `pending` for the resumed dispatch. True when a
   * held row was updated.
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
        // As computeFailureClass: consistent with every other cancel path, and
        // matched by a class-scoped subscription.
        failure_class: RunFailureClass.enum.cancelled,
      })
      .where('run_id', '=', runId)
      .where('status', '=', ExecutionRunStatus.enum.held)
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      logger.warn('cancelHeldRun: no held run to cancel', { runId });
      return;
    }
    // No `onExecutionComplete` fires on this arm, so drop in-process state here.
    this.onRunTerminalCleanup?.(runId);
    this.onExecutionStatusChange?.(
      runId,
      ExecutionRunStatus.enum.cancelled,
      {
        workflowName: row.workflow_name,
        ...statusEpochField(row.status_epoch),
        provider: row.provider ?? '',
        repoIdentifier: row.repo_identifier ?? '',
        ...(row.is_global_eval_round === true && { isGlobalEvalRound: true }),
        sha: row.sha ?? '',
        routingKey: row.routing_key ?? undefined,
        ref: row.ref ?? '',
        failureClass: RunFailureClass.enum.cancelled,
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
   * Cancel a run that has no job rows: a run cancelled before it dispatched
   * any job, a pre-run evaluation round, or a `pending` row a crash left
   * behind. No job will report a terminal status, so the cancel writes and
   * forwards the terminal row itself, as `cancelHeldRun` does.
   *
   * Guarded on non-terminal, not `held`, and no job rows: a run that gained a
   * job meanwhile is left to job-driven completion, a held run to the
   * hold-rejection path. A reason already on the row wins over `reason`.
   * Returns whether a row was cancelled.
   */
  async cancelJoblessRun(runId: string, reason: string): Promise<boolean> {
    const now = new Date();
    const row = await this.db
      .updateTable('execution_runs')
      .set({
        status: ExecutionRunStatus.enum.cancelled,
        completed_at: now,
        failure_reason: sql<string>`COALESCE(execution_runs.failure_reason, ${reason})`,
        failure_class: RunFailureClass.enum.cancelled,
      })
      .where('run_id', '=', runId)
      // A held run is left to the hold-rejection path, which also withdraws its
      // approval request; cancelling only the row would leave that request live.
      // fails-when: a cancel moves a held run to cancelled while its hold stays pending
      // breaks-if-wrong: a jobless pending run must still reach cancelled
      .where('status', 'not in', [...TERMINAL_RUN_STATES, ExecutionRunStatus.enum.held])
      // fails-when: a cancel terminalizes a run whose jobs will report their own terminal status
      // breaks-if-wrong: a run with no job rows must still reach `cancelled`
      .where(
        sql<boolean>`NOT EXISTS (SELECT 1 FROM execution_jobs ej WHERE ej.run_id = execution_runs.run_id)`,
      )
      .returningAll()
      .executeTakeFirst();
    if (!row) return false;
    this.onRunTerminalCleanup?.(runId);
    this.onExecutionStatusChange?.(
      runId,
      ExecutionRunStatus.enum.cancelled,
      {
        workflowName: row.workflow_name,
        ...statusEpochField(row.status_epoch),
        provider: row.provider ?? '',
        repoIdentifier: row.repo_identifier ?? '',
        ...(row.workflow_repo_identifier && {
          workflowRepoIdentifier: row.workflow_repo_identifier,
        }),
        ...(row.is_global_eval_round === true && { isGlobalEvalRound: true }),
        sha: row.sha ?? '',
        routingKey: row.routing_key ?? undefined,
        ref: row.ref ?? '',
        failureClass: RunFailureClass.enum.cancelled,
      },
      0,
      row.started_at ? new Date(row.started_at).getTime() : now.getTime(),
      now.getTime(),
      0,
      row.failure_reason ?? reason,
    );
    logger.info('Cancelled a run with no jobs', { runId, reason });
    return true;
  }

  /**
   * Fail a run immediately, e.g. when no agents can take any job (cron-triggered
   * runs on a cluster leader without matching local agents and no reachable
   * peers), rather than leave it 'running' for OrphanRecovery to catch after
   * 5 min.
   */
  async failRun(runId: string, reason: string, initFailure?: InitFailure): Promise<void> {
    const now = new Date();

    const run = this.runs.get(runId);
    const durationMs = run ? now.getTime() - run.startedAt : 0;

    // Cascades to execution_runs, execution_jobs and dispatch_queue.
    await this.db
      .updateTable('execution_runs')
      .set({
        status: ExecutionRunStatus.enum.failed,
        completed_at: now,
        duration_ms: durationMs,
        failure_reason: reason,
        // Never executed a step (init failure / no agent): the infra-class
        // failure customers most want alerts on.
        failure_class: RunFailureClass.enum.never_started,
        ...(initFailure && { init_failure: JSON.stringify(initFailure) }),
      })
      .where('run_id', '=', runId)
      .execute();

    await this.db
      .updateTable('execution_jobs')
      .set({
        status: ExecutionJobStatus.enum.failed,
        completed_at: now,
        error_message: reason,
        // A job leaving the queue has no routing reason; the read boundary
        // hides it (`visibleRoutingReason`), and clearing keeps the row honest.
        routing_reason: null,
      })
      .where('run_id', '=', runId)
      .where('status', 'in', [ExecutionJobStatus.enum.pending, ExecutionJobStatus.enum.queued])
      .execute();

    // Fails pending/recovering dispatch_queue entries.
    await this.jobQueue?.failByRunId(runId);
    await this.clearRegistrationWindow(runId);

    executionsTotal.add(1, { status: ExecutionRunStatus.enum.failed });
    executionDurationSeconds.record(durationMs / 1000);

    // Outside `if (run)`: a run this instance never tracked in memory (a peer
    // ingested the webhook, or a restart) still has `pending_job_contexts` rows,
    // and `cleanupPendingJobContexts` is keyed on runId alone.
    this.onRunTerminalCleanup?.(runId);

    if (run) {
      const completedAt = now.getTime();
      this.onExecutionStatusChange?.(
        runId,
        ExecutionRunStatus.enum.failed,
        {
          ...runSummaryFields(run),
          failureClass: RunFailureClass.enum.never_started,
        },
        run.jobs.size,
        run.startedAt,
        completedAt,
        completedAt - run.startedAt,
        reason,
        undefined,
        initFailure,
      );

      // Plane B parity: a never-started run emits workflow_complete too, in the
      // normal-path shape, so workflowComplete triggers react to it;
      // orchestrator-core forwards it to the __workflow_complete event.
      this.onWorkflowComplete?.({
        runId,
        workflowName: run.workflowName,
        status: ExecutionRunStatus.enum.failed,
        duration: completedAt - run.startedAt,
        jobResults: Array.from(run.jobs.values()).map((j) => ({ name: j.name, status: j.status })),
        routingKey: run.routingKey,
        repo: run.repoIdentifier,
        failureClass: RunFailureClass.enum.never_started,
      });

      this.runs.delete(runId);
      this.jobLogBytes.delete(runId);
    }

    logger.info('Execution marked failed', { runId, reason });
  }

  /**
   * Upsert a step's execution_steps row (started_at on 'running';
   * completed_at, duration_ms, exit_code on terminal), with its log_path, and
   * forward it to the Platform.
   *
   * @param logBytesStreamed Raw byte total from the agent's LogStreamer at
   *   terminal step time; summed into `execution_jobs.log_bytes` and
   *   `execution_runs.log_bytes`, feeding the Platform's operator-side
   *   `kici_org_log_bytes` capacity-planning gauge.
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
    // Counted once per step: the agent sets logBytesStreamed only on terminal
    // states. Undefined (e.g. older agents) is accepted silently.
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
    const jobName = await this.resolveJobName(runId, jobId);
    const logPath = stepLogPath(runId, jobName, stepIndex);
    const now = new Date(timestamp);

    // One object for both the insert and the conflict update.
    const values: Record<string, unknown> = {
      run_id: runId,
      job_id: jobId,
      step_index: stepIndex,
      step_name: stepName,
      status: state,
      log_path: logPath,
      // Denormalized (migration 006); onExecutionStarted / DB-recovery fill
      // the in-memory run before steps fire.
      routing_key: this.runs.get(runId)?.routingKey ?? null,
    };

    // e.g. 'hook:onCancel', 'hook:cleanup'
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
        values.error_message = errorText(data.error);
      }
    }

    // Persisted whenever present, even an empty array.
    if (data?.secretsAccessed !== undefined) {
      values.secrets_accessed = JSON.stringify(data.secretsAccessed);
    }

    // Check-mode per-step fields, from the agent's step.complete IPC.
    if (data?.checkOutcome !== undefined) {
      values.check_outcome = String(data.checkOutcome);
      // Run-level drift decides the check-fail-on-drift terminal status.
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

    // Parallel step-group metadata. Each parallel child has a distinct flat
    // step_index, so the (run_id, job_id, step_index) upsert key stays unique.
    if (data?.concurrencyKind !== undefined) {
      values.concurrency_kind = String(data.concurrencyKind);
    }
    if (data?.groupId !== undefined) {
      values.group_id = String(data.groupId);
    }

    await this.db
      .insertInto('execution_steps')
      .values(values as any)
      .onConflict((oc) => oc.columns(['run_id', 'job_id', 'step_index']).doUpdateSet(values as any))
      .execute();

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

    // Observers see test runs only.
    if (this.observerRegistry && this.testRunIds.has(runId)) {
      const durationMs = data?.durationMs !== undefined ? Number(data.durationMs) : undefined;
      this.observerRegistry.broadcastStep(runId, jobId, jobName, stepName, state, durationMs);
    }
  }

  /** Whether every tracked job of the run is terminal. */
  isRunComplete(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    // Jobs still to register (holdRunForPendingJobs): "all terminal" says
    // nothing yet.
    if ((run.pendingJobRegistrations ?? 0) > 0) return false;
    for (const job of run.jobs.values()) {
      if (!TERMINAL_JOB_STATES.has(job.status)) {
        return false;
      }
    }
    return run.jobs.size > 0;
  }

  /**
   * Take a token holding a run open while some of its jobs are still to be
   * registered. False for an unknown or already-completed run.
   *
   * The registration windows: a run whose source-pack `__build__` job goes
   * first is registered with that job ALONE, its real jobs dispatched after the
   * build; a run without a build is registered with NO jobs before its dispatch
   * loop; a deferred init job and a deferred dynamic entry register from a
   * fire-and-forget task that outlives the dispatch call. Without a token, the
   * already-registered jobs going terminal satisfy {@link isRunComplete}, so a
   * terminal status is written, the provider check posted and the status
   * forwarded — before a single real job has run.
   *
   * The hold is a counter read only by {@link isRunComplete}, deliberately NOT
   * a synthetic job-map entry: every outward projection enumerates the job map
   * (the Platform `state.replay` snapshot and its `execution_jobs` mirror, the
   * job count, workflow-complete job results, the active-run summary), so a
   * marker there would be a phantom pending job and an off-by-one count. The
   * counter writes no `execution_jobs` row either.
   *
   * A token whose holder never settles keeps the run open until the stale
   * detector reaps it, which reaches only a run with at least one job (every
   * sub-scan starts from `execution_jobs` or `dispatch_queue`). So a holder that
   * registers NO jobs must terminalize the run itself, as
   * `dispatchMatchedWorkflow` does when its dispatch loop throws.
   *
   * Each token must be paired with exactly one {@link releasePendingJobsHold}.
   */
  holdRunForPendingJobs(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.completedAt) return false;
    run.pendingJobRegistrations = (run.pendingJobRegistrations ?? 0) + 1;
    if (run.pendingJobRegistrations === 1) this.openRegistrationWindow(runId);
    return true;
  }

  /**
   * Record this coordinator in `execution_runs.registration_window_instance_id`
   * — the token's durable form, which a sibling finalizing the run consults.
   *
   * Chained, not awaited: the caller is synchronous by contract (the token must
   * be counted before the next `await` can drop a sibling token), and the clear
   * on the last release awaits the chain. `registrationWindowSettled` exposes
   * it to a caller that needs the window durable before waiting on a job a
   * sibling may finish. No instance id, no durable window.
   */
  private openRegistrationWindow(runId: string): void {
    const instanceId = this.instanceId;
    if (!instanceId) return;
    runDetached(
      logger,
      'Registration window open',
      () =>
        this.chainRegistrationWindowWrite(runId, async () => {
          await this.db
            .updateTable('execution_runs')
            .set({ registration_window_instance_id: instanceId })
            .where('run_id', '=', runId)
            .execute();
        }),
      { runId },
    );
  }

  /**
   * Clear the durable registration window, only if it still names this
   * coordinator — a sibling that took the run over owns the column now.
   */
  private async clearRegistrationWindow(runId: string): Promise<void> {
    const instanceId = this.instanceId;
    if (!instanceId) return;
    await this.chainRegistrationWindowWrite(runId, async () => {
      await this.db
        .updateTable('execution_runs')
        .set({ registration_window_instance_id: null })
        .where('run_id', '=', runId)
        .where('registration_window_instance_id', '=', instanceId)
        .execute();
    });
  }

  private chainRegistrationWindowWrite(runId: string, write: () => Promise<void>): Promise<void> {
    const prior = this.registrationWindowWrites.get(runId) ?? Promise.resolve();
    const next = prior.then(write).catch((err: unknown) => {
      logger.error('Registration window write failed', { runId, error: toErrorMessage(err) });
    });
    this.registrationWindowWrites.set(runId, next);
    runDetached(
      logger,
      'Registration window write cleanup',
      () =>
        next.finally(() => {
          if (this.registrationWindowWrites.get(runId) === next) {
            this.registrationWindowWrites.delete(runId);
          }
        }),
      { runId },
    );
    return next;
  }

  /** Resolves once every registration-window write queued so far for the run has landed. */
  registrationWindowSettled(runId: string): Promise<void> {
    return this.registrationWindowWrites.get(runId) ?? Promise.resolve();
  }

  /**
   * Drop one token taken by {@link holdRunForPendingJobs}, and finalize the run
   * if dropping the LAST one left every remaining job terminal.
   *
   * As in `addJobsToRun`, nothing else drives a completion check once the last
   * token is gone, so a run whose jobs all finished meanwhile would hang in
   * `running` forever. Only the last release may finalize: while another token
   * is outstanding, more jobs are on their way.
   *
   * Idempotent: a no-op with no token outstanding. The count clamps at zero, so
   * a stray extra release cannot go negative and stop a genuinely outstanding
   * token from holding the run open.
   */
  async releasePendingJobsHold(runId: string): Promise<void> {
    if (!this.runs.has(runId)) {
      // The run left memory while held (failed, held, or finished elsewhere).
      // The durable window must not outlive it: a sibling reads a live holder
      // as "still registering" and defers forever.
      await this.clearRegistrationWindow(runId);
      return;
    }
    if ((this.runs.get(runId)?.pendingJobRegistrations ?? 0) <= 0) return;
    await this.withRunLock(runId, async () => {
      const run = this.runs.get(runId);
      if (!run || (run.pendingJobRegistrations ?? 0) <= 0) return;
      run.pendingJobRegistrations = Math.max(0, (run.pendingJobRegistrations ?? 0) - 1);
      if (run.pendingJobRegistrations > 0) return;
      await this.clearRegistrationWindow(runId);
      if (run.completedAt) return;
      // Fold in what siblings finished meanwhile: a sibling that saw the last
      // job finish deferred to this window, and nothing else re-drives it.
      await this.syncRunJobsFromRows(run, runId);
      if (!this.isRunComplete(runId)) return;
      const stopAfterStuckCheck = await this.enforceSchedulerInvariantOrFail(runId);
      if (!stopAfterStuckCheck && (await this.readyToFinalize(run, runId))) {
        await this.finalizeRunCompletion(run, runId, Date.now(), new Date());
      }
    });
  }

  getRunStatus(
    runId: string,
  ): Extract<ExecutionRunStatus, 'running' | 'success' | 'failed' | 'cancelled'> {
    const run = this.runs.get(runId);
    if (!run) return ExecutionRunStatus.enum.running;
    if (!this.isRunComplete(runId)) return ExecutionRunStatus.enum.running;
    return this.computeRunStatus(run);
  }

  /** In-memory job name lookup, used by LogWriter for log paths. */
  getJobName(runId: string, jobId: string): string | undefined {
    return this.runs.get(runId)?.jobs.get(jobId)?.name;
  }

  /**
   * Resolve the job name in a step-log storage path
   * (`executions/{runId}/job-{jobName}/…`), with a durable fallback. Both
   * writers — the chunk writer (`log-chunk-sink`) and the
   * `execution_steps.log_path` upsert in `onStepStatus` — use this, so they
   * cannot disagree. `getJobName` is `undefined` between dispatch and
   * `addJobsToRun`, which would put an early chunk under `job-{jobId}` while the
   * reader keys on `job-{realName}`, silently losing lines. Order: in-memory,
   * then `dispatch_queue.job_name` (as `recoverJobFromDispatchQueue` trusts),
   * then `jobId` for a genuinely unknown job.
   */
  async resolveJobName(runId: string, jobId: string): Promise<string> {
    const cached = this.runs.get(runId)?.jobs.get(jobId)?.name;
    if (cached) return cached;
    const queueEntry = await this.db
      .selectFrom('dispatch_queue')
      .select(['job_name'])
      .where('id', '=', jobId)
      .executeTakeFirst();
    return queueEntry?.job_name ?? jobId;
  }

  /**
   * Seed the in-memory job name of a worker-rerouted job at reroute time. It
   * never enters `run.jobs` via `addJobsToRun` and has no coordinator-owned
   * `dispatch_queue` row (the worker owns it under a fresh id), so
   * `resolveJobName` would fall back to the bare `jobId` for early log chunks
   * while the reader keys on the real name, losing lines. In-memory only: the
   * worker's first status update creates the `execution_jobs` row. An existing
   * entry is never clobbered, so a later terminal status survives.
   */
  registerJobName(runId: string, jobId: string, jobName: string, workflowName?: string): void {
    const run = this.runs.get(runId);
    if (!run || run.jobs.has(jobId)) return;
    // Same shape as recoverJobFromDispatchQueue; the workflow names the row the
    // worker's first status update creates.
    run.jobs.set(jobId, {
      name: jobName,
      ...(workflowName && { workflowName }),
      status: ExecutionJobStatus.enum.pending,
    } as any);
  }

  /**
   * The in-memory run owning a dispatched jobId, so `getExecutionContext`
   * resolves for a job-scoped agent `event.emit`. In-memory only, like
   * `getExecutionContext`: emit happens mid-execution, so the run is live.
   */
  getRunIdForJob(jobId: string): string | undefined {
    for (const [runId, run] of this.runs) {
      if (run.jobs.has(jobId)) return runId;
    }
    return undefined;
  }

  /**
   * In-memory execution context of a run, for commit status reporting.
   */
  getExecutionContext(runId: string): ExecutionContext | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    return {
      workflowName: run.workflowName,
      provider: run.provider,
      repoIdentifier: run.repoIdentifier,
      ...(run.workflowRepoIdentifier && { workflowRepoIdentifier: run.workflowRepoIdentifier }),
      sha: run.sha,
      installationId: run.installationId,
      routingKey: run.routingKey,
      concurrency: run.concurrency,
      triggerActorUsername: run.triggerActorUsername,
      triggerActorUserId: run.triggerActorUserId,
      ...(run.trustTier !== undefined && { trustTier: run.trustTier }),
      ...(run.lockFileSource !== undefined && { lockFileSource: run.lockFileSource }),
    };
  }

  /**
   * Stamp the run's resolved trust tier and lock-file branch onto the in-memory
   * state, after `onExecutionStarted` recorded the row.
   *
   * Trust resolves on its own path with its own `execution_runs` update. The
   * dispatch site calls this with the same values, but either write can be
   * lost (the DB update is fire-and-forget with its own `.catch()`, and this
   * call sits in a `try`/`catch`) — deliberately, as the note is worth less
   * than the run. So memory and the row CAN disagree; `recoverRunFromDb` reads
   * the row, so the durable value survives.
   *
   * An unknown run is a no-op: the status updates that would read the fields
   * are not coming either.
   *
   * Keep this synchronous: callers' `try`/`catch` catches a throw, not a
   * rejected promise.
   */
  setRunTrustContext(runId: string, trustTier: string, lockFileSource?: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.trustTier = trustTier;
    if (lockFileSource !== undefined) run.lockFileSource = lockFileSource;
  }

  /**
   * Stamp a running job's heartbeat on an agent job.heartbeat; the
   * status='running' predicate leaves completed jobs alone.
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

  /** Count of non-completed runs in memory. */
  getActiveRunCount(): number {
    let count = 0;
    for (const run of this.runs.values()) {
      if (!run.completedAt) count++;
    }
    return count;
  }

  /**
   * Summary of active runs (with job counts) for the cluster health API.
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
      if (run.completedAt) continue;

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
          // Shared classification, not a hand-listed set: a terminal job that
          // never ran (`drift_dropped`, `unroutable`) is not still running.
          isFailureStatus(job.status) ||
          job.status === ExecutionJobStatus.enum.cancelled
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
   * Replay data for every in-memory run (active and recently completed), sent
   * as state.replay on reconnection so the Platform reconciles its
   * execution_runs and execution_jobs projections.
   */
  getReplayData(): Array<{
    runId: string;
    workflowName: string;
    status: ExecutionRunStatus;
    routingKey?: string;
    repoIdentifier?: string;
    workflowRepoIdentifier?: string;
    sha?: string;
    ref?: string;
    triggerEvent?: string;
    commitMessage?: string;
    parentRunId?: string | null;
    originalRunId?: string | null;
    triggeredBy?: string | null;
    triggeredByAgentLabel?: string | null;
    failureReason?: string;
    failureClass?: RunFailureClass;
    jobCount: number;
    startedAt: number;
    completedAt?: number;
    durationMs?: number;
    statusEpoch: number;
    jobs: Array<{
      jobId: string;
      jobName: string;
      workflowName?: string;
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
      workflowRepoIdentifier?: string;
      sha?: string;
      ref?: string;
      triggerEvent?: string;
      commitMessage?: string;
      parentRunId?: string | null;
      originalRunId?: string | null;
      triggeredBy?: string | null;
      triggeredByAgentLabel?: string | null;
      failureReason?: string;
      jobCount: number;
      startedAt: number;
      completedAt?: number;
      durationMs?: number;
      statusEpoch: number;
      jobs: Array<{
        jobId: string;
        jobName: string;
        workflowName?: string;
        status: string;
        startedAt?: number;
        completedAt?: number;
        agentId?: string;
        runsOnLabels?: string[];
        contexts?: string[];
      }>;
    }> = [];

    for (const [runId, run] of this.runs) {
      const isComplete = this.isRunComplete(runId);
      const status = isComplete ? this.computeRunStatus(run) : run.status;
      const failureClass = isComplete
        ? this.computeFailureClass(status, [...run.jobs.values()])
        : null;
      const durationMs = run.completedAt ? run.completedAt - run.startedAt : undefined;

      const jobs: Array<{
        jobId: string;
        jobName: string;
        workflowName?: string;
        status: string;
        startedAt?: number;
        completedAt?: number;
        agentId?: string;
        runsOnLabels?: string[];
        contexts?: string[];
      }> = [];

      for (const [jobId, job] of run.jobs) {
        jobs.push({
          jobId,
          jobName: job.name,
          ...(job.workflowName && { workflowName: job.workflowName }),
          status: job.status,
          ...(job.startedAt !== undefined && { startedAt: job.startedAt }),
          ...(job.agentId && { agentId: job.agentId }),
          ...(job.runsOnLabels?.length && { runsOnLabels: job.runsOnLabels }),
          ...(job.contexts?.length && { contexts: job.contexts }),
        });
      }

      result.push({
        runId,
        workflowName: run.workflowName,
        status,
        routingKey: run.routingKey,
        repoIdentifier: run.repoIdentifier,
        ...(run.workflowRepoIdentifier && { workflowRepoIdentifier: run.workflowRepoIdentifier }),
        sha: run.sha,
        ref: run.ref,
        triggerEvent: run.triggerEvent,
        commitMessage: run.commitMessage,
        parentRunId: run.parentRunId,
        originalRunId: run.originalRunId,
        triggeredBy: run.triggeredBy,
        triggeredByAgentLabel: run.triggeredByAgentLabel,
        ...(run.failureReason && { failureReason: run.failureReason }),
        ...(failureClass && { failureClass }),
        jobCount: run.jobs.size,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        durationMs,
        // Always sent, so the Platform applies its keep-terminal rule to a replay.
        statusEpoch: run.statusEpoch ?? 0,
        jobs,
      });
    }

    return result;
  }

  /**
   * Replay data merged with terminal runs read from the orchestrator's local DB.
   *
   * After a crash/restart memory is empty, but runs completed before it are
   * still in `execution_runs`; without re-emitting them the Platform mirror
   * (and the `kici_org_executions_count` operator-aggregate gauge) silently
   * undercounts.
   *
   * Returns the in-memory items first, in order (callers may rely on it for
   * active-run metadata), then appends uncovered terminal DB runs completed
   * within `windowHours` (default 24h), in `completed_at ASC` order.
   *
   * Idempotent: the Platform's `state.replay` handler upserts on `run_id`, so
   * re-emitting a mirrored run is a no-op for billing and dashboard state.
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
      workflow_repo_identifier: string | null;
      sha: string;
      ref: string;
      started_at: Date;
      completed_at: Date | null;
      duration_ms: number | null;
      parent_run_id: string | null;
      original_run_id: string | null;
      triggered_by: string | null;
      triggered_by_agent_label: string | null;
      failure_reason: string | null;
      failure_class: string | null;
      status_epoch: number;
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
          'workflow_repo_identifier',
          'sha',
          'ref',
          'started_at',
          'completed_at',
          'duration_ms',
          'parent_run_id',
          'original_run_id',
          'triggered_by',
          'triggered_by_agent_label',
          'failure_reason',
          'failure_class',
          'status_epoch',
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
      Array<{ jobId: string; jobName: string; workflowName?: string; status: string }>
    >();
    try {
      const jobIds = dbRuns.filter((r) => !seen.has(r.run_id)).map((r) => r.run_id);
      if (jobIds.length > 0) {
        const dbJobs = await this.db
          .selectFrom('execution_jobs')
          .select(['run_id', 'job_id', 'job_name', 'workflow_name', 'status'])
          .where('run_id', 'in', jobIds)
          .execute();
        for (const j of dbJobs) {
          const arr = dbJobsByRun.get(j.run_id) ?? [];
          arr.push({
            jobId: j.job_id,
            jobName: j.job_name,
            ...(j.workflow_name && { workflowName: j.workflow_name }),
            status: j.status,
          });
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
        ...(r.workflow_repo_identifier && {
          workflowRepoIdentifier: r.workflow_repo_identifier,
        }),
        sha: r.sha,
        ref: r.ref,
        parentRunId: r.parent_run_id,
        originalRunId: r.original_run_id,
        triggeredBy: r.triggered_by,
        triggeredByAgentLabel: r.triggered_by_agent_label,
        ...(r.failure_reason && { failureReason: r.failure_reason }),
        ...(r.failure_class && { failureClass: r.failure_class as RunFailureClass }),
        jobCount: jobs.length,
        startedAt: r.started_at.getTime(),
        ...(r.completed_at && { completedAt: r.completed_at.getTime() }),
        ...(r.duration_ms !== null && { durationMs: r.duration_ms }),
        statusEpoch: r.status_epoch ?? 0,
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
   * Update a job's in-memory status only, for StaleRunDetector, which writes
   * the DB itself and needs memory in sync for completion detection.
   */
  updateInMemoryJob(runId: string, jobId: string, status: string): void {
    const job = this.runs.get(runId)?.jobs.get(jobId);
    if (job) job.status = status;
  }

  /**
   * Forward a terminal job status to the Platform's execution_jobs projection,
   * for StaleRunDetector and OrphanRecovery, which write the DB directly.
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
      undefined,
      undefined,
      job?.contexts,
      job?.workflowName,
    );
  }

  /**
   * Public run.event emitter for StaleRunDetector and OrphanRecovery.
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
   * Cancel a job's non-terminal steps after infrastructure terminated it (stale
   * detection, orphan recovery, recovery timeout), so the dashboard shows no
   * stale running steps.
   */
  async cancelStepsForJob(runId: string, jobId: string, reason: string): Promise<void> {
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
   * Complete the run when every job is terminal, from memory or else from the
   * DB (crash recovery / pruned runs). Called by StaleRunDetector after
   * marking stale jobs.
   */
  async completeRunIfAllJobsTerminal(runId: string): Promise<void> {
    // A live sibling's registration window means rows for its jobs do not exist
    // yet, so "every row terminal" is not done.
    if (await this.registrationWindowHeldByLiveSibling(runId)) return;

    // Path A: in-memory state, already complete.
    const memRun = this.runs.get(runId);
    if (memRun && this.isRunComplete(runId)) {
      await this.completeRunFromMemoryState(memRun, runId);
      return;
    }

    // Path B: the DATABASE decides — with no in-memory state (crash recovery,
    // a sibling's run) and with memory BEHIND the rows: the cancel path writes
    // terminal `execution_jobs` rows directly, so memory still reads `pending`.
    // Trusting memory stranded a cancelled never-dispatched run in `pending`.
    // A no-op unless every job row is terminal, so "still running" costs one read.
    await this.completeRunFromDbFallback(runId);
  }

  /**
   * Path A helper: complete a locally tracked run from memory — terminal row,
   * Platform-forwarding and workflow-complete callbacks, pruning.
   *
   * The terminal write is clobber-guarded. On rejection (the run finished on
   * the normal path) only pruning happens: the recomputed status is not this
   * orchestrator's record, so no callback or metric may claim it.
   */
  private async completeRunFromMemoryState(memRun: RunState, runId: string): Promise<void> {
    const overallStatus = this.computeRunStatus(memRun);
    memRun.completedAt = Date.now();
    const durationMs = memRun.completedAt - memRun.startedAt;

    const staleFailureReason =
      overallStatus === ExecutionRunStatus.enum.failed
        ? 'Run completed via stale detection (no heartbeat received)'
        : undefined;

    const failureClass = this.computeFailureClass(overallStatus, [...memRun.jobs.values()]);

    const applied = await this.db
      .updateTable('execution_runs')
      .set({
        status: overallStatus,
        completed_at: new Date(),
        duration_ms: durationMs,
        failure_class: failureClass,
      })
      .where('run_id', '=', runId)
      .where('status', 'in', [
        ExecutionRunStatus.enum.pending,
        ExecutionRunStatus.enum.running,
        ExecutionRunStatus.enum.cancelling,
      ])
      .executeTakeFirst();

    // On rejection `overallStatus` is NOT our record: a job marked
    // `timed_out_stale` after the run finished green recomputes to `failed`
    // while the row correctly reads `success`. The Platform never revisits a
    // terminal mirror row, so forwarding would diverge the planes permanently.
    // Emit nothing: the normal path already forwarded the real status, and a
    // mirror stuck non-terminal is what the Platform's run-mirror reconciler
    // re-pulls.
    if (!guardedWriteApplied(applied)) {
      logger.debug('Stale-detector completion skipped: run already terminal in DB', {
        runId,
        recomputedStatus: overallStatus,
      });
      this.scheduleRunPrune(runId);
      return;
    }

    // The generic stale reason never replaces a specific one (e.g. a scaler
    // provisioning error or an agent step failure), which stays visible in
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
        ...(memRun.workflowRepoIdentifier && {
          workflowRepoIdentifier: memRun.workflowRepoIdentifier,
        }),
        sha: memRun.sha,
        ...(memRun.localWorkingTree && { localWorkingTree: true }),
        installationId: memRun.installationId,
        requestId: memRun.requestId,
        routingKey: memRun.routingKey,
      },
      description,
    );

    this.onExecutionStatusChange?.(
      runId,
      overallStatus,
      {
        ...runSummaryFields(memRun),
        ...(memRun.localWorkingTree && { localWorkingTree: true }),
        failureClass,
      },
      memRun.jobs.size,
      memRun.startedAt,
      memRun.completedAt,
      durationMs,
      staleFailureReason,
    );

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
      ...(failureClass && { failureClass }),
    });

    this.scheduleRunPrune(runId);
  }

  /**
   * Drop the in-memory state of every run another writer already finished.
   *
   * A coordinator prunes a run only when it sees the last job finish. In a
   * cluster a sibling may see it instead, leaving this copy in memory for the
   * process lifetime (one `RunState` per cross-coordinator run). The stale
   * detector calls this every tick; a run whose row is terminal is released
   * like the finalizer's own, minus the completion events and row write.
   *
   * A run whose row is non-terminal (with or without an open registration
   * window) is not touched.
   */
  async pruneRunsFinishedElsewhere(): Promise<number> {
    const candidates = [...this.runs.entries()]
      .filter(([, run]) => !run.completedAt)
      .map(([runId]) => runId);
    if (candidates.length === 0) return 0;
    const rows = await this.db
      .selectFrom('execution_runs')
      .select(['run_id', 'status'])
      .where('run_id', 'in', candidates)
      .where('status', 'in', [...TERMINAL_RUN_STATES])
      .execute();
    let released = 0;
    for (const row of rows) {
      if (typeof row.run_id !== 'string') continue;
      if (this.releaseRunFinishedElsewhere(row.run_id)) released++;
    }
    if (released > 0) {
      logger.info('Released in-memory state of runs finished by another coordinator', {
        released,
      });
    }
    return released;
  }

  /**
   * Finish here a run another writer finished: mark it complete so no
   * completion path re-enters it, shed its terminal-callback state, schedule
   * the prune. No event, no row write. False when not held or already
   * finishing.
   */
  private releaseRunFinishedElsewhere(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.completedAt) return false;
    run.completedAt = Date.now();
    // Tokens are moot now; dropping the state lets a late release find no run
    // and clear the durable window.
    run.pendingJobRegistrations = 0;
    this.onRunTerminalCleanup?.(runId);
    this.scheduleRunPrune(runId);
    logger.info('Run finished by another coordinator; releasing in-memory state', { runId });
    return true;
  }

  /**
   * Drop a finished run's in-memory state after a grace period, so a late
   * status/heartbeat arriving just after completion still finds its run.
   *
   * The single owner of run-lifetime teardown, so every run-lifetime map is
   * cleared here — `testRunIds` too, or a stale-detector-finished run leaks its
   * observer marker. (`runLockTails` is deliberately skipped: scoped to a
   * lock's holders, `withRunLock` drops its own entry on release.)
   */
  private scheduleRunPrune(runId: string): void {
    setTimeout(() => {
      this.runs.delete(runId);
      this.testRunIds.delete(runId);
      this.jobLogBytes.delete(runId);
      this.onRunPruned?.(runId);
    }, PRUNE_DELAY_MS);
  }

  /**
   * Path B helper: complete a run from DB rows only (crash recovery / pruned
   * runs) — all-terminal predicate, run-state guard, terminal row,
   * Platform-forwarding callbacks.
   *
   * The run-state read and the write are separate statements, so the write has
   * its own clobber guard; when a concurrent normal completion lands between
   * them, callbacks and metrics are suppressed too.
   */
  private async completeRunFromDbFallback(runId: string): Promise<void> {
    const jobs = await this.db
      .selectFrom('execution_jobs')
      .select(['status', 'job_name', 'workflow_name'])
      .where('run_id', '=', runId)
      .execute();

    const allTerminal = jobs.length > 0 && jobs.every((j) => TERMINAL_JOB_STATES.has(j.status));
    if (!allTerminal) return;

    // The engine's shared classification, as `computeRunStatus` uses, so the
    // paths agree on "failed". A hand-listed set reported success for a run
    // whose only non-success job was `drift_dropped` or `unroutable`.
    const hasFailed = jobs.some((j) => isFailureStatus(j.status));
    const hasCancelled = jobs.some((j) => j.status === ExecutionJobStatus.enum.cancelled);
    const overallStatus: Extract<ExecutionRunStatus, 'success' | 'failed' | 'cancelled'> = hasFailed
      ? ExecutionRunStatus.enum.failed
      : hasCancelled
        ? ExecutionRunStatus.enum.cancelled
        : ExecutionRunStatus.enum.success;

    // Optimistic concurrency: the run must still be non-terminal.
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
        'triggered_by_agent_label',
        'trigger_actor_username',
        'trigger_actor_user_id',
        'workflow_repo_identifier',
        'status_epoch',
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

    const failureClass = this.computeFailureClass(overallStatus, jobs);

    const applied = await this.db
      .updateTable('execution_runs')
      .set({
        status: overallStatus,
        completed_at: now,
        duration_ms: durationMs,
        failure_class: failureClass,
      })
      .where('run_id', '=', runId)
      .where('status', 'in', [
        ExecutionRunStatus.enum.pending,
        ExecutionRunStatus.enum.running,
        ExecutionRunStatus.enum.cancelling,
      ])
      .executeTakeFirst();

    // A concurrent normal completion can land between the `dbRun` read and this
    // write; then `overallStatus` is not our record and must not be forwarded
    // (see `guardedWriteApplied`).
    if (!guardedWriteApplied(applied)) {
      logger.debug('DB-fallback completion skipped: run already terminal in DB', {
        runId,
        recomputedStatus: overallStatus,
      });
      return;
    }

    // In-memory state behind the rows (the cancel sweep updates job rows
    // directly) is stamped and released as on the memory path; otherwise the
    // cluster health API reports it active forever and nothing frees it.
    const memRun = this.runs.get(runId);
    if (memRun) {
      memRun.completedAt = now.getTime();
      this.scheduleRunPrune(runId);
    }

    // Never replaces a more specific reason (as on the memory path).
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

    const providerCtx =
      typeof dbRun.provider_context === 'string'
        ? JSON.parse(dbRun.provider_context)
        : (dbRun.provider_context ?? {});
    const installationId =
      typeof providerCtx.installationId === 'number' ? providerCtx.installationId : undefined;

    // Same shared classification as `buildRunDescription`, so a run failed only
    // by a job that never ran does not get an empty `Failed jobs:`.
    const description =
      overallStatus !== ExecutionRunStatus.enum.success
        ? failedJobsSummary(
            jobs.map((j) => ({
              name: j.job_name,
              workflowName: j.workflow_name,
              status: j.status,
            })),
          )
        : undefined;

    this.onExecutionComplete?.(
      runId,
      overallStatus,
      {
        workflowName: dbRun.workflow_name,
        provider: dbRun.provider,
        repoIdentifier: dbRun.repo_identifier,
        ...(dbRun.workflow_repo_identifier && {
          workflowRepoIdentifier: dbRun.workflow_repo_identifier,
        }),
        sha: dbRun.sha,
        installationId,
        routingKey: dbRun.routing_key ?? undefined,
      },
      description,
    );

    this.onExecutionStatusChange?.(
      runId,
      overallStatus,
      {
        workflowName: dbRun.workflow_name,
        ...statusEpochField(dbRun.status_epoch),
        provider: dbRun.provider,
        repoIdentifier: dbRun.repo_identifier,
        ...(dbRun.workflow_repo_identifier && {
          workflowRepoIdentifier: dbRun.workflow_repo_identifier,
        }),
        sha: dbRun.sha,
        installationId,
        routingKey: dbRun.routing_key ?? undefined,
        ref: dbRun.ref,
        parentRunId: dbRun.parent_run_id ?? undefined,
        originalRunId: dbRun.original_run_id ?? undefined,
        triggeredBy: dbRun.triggered_by ?? undefined,
        triggeredByAgentLabel: dbRun.triggered_by_agent_label ?? undefined,
        triggerActorUsername: dbRun.trigger_actor_username ?? undefined,
        triggerActorUserId: dbRun.trigger_actor_user_id ?? undefined,
        failureClass,
      },
      jobs.length,
      new Date(dbRun.started_at).getTime(),
      now.getTime(),
      durationMs,
      orphanFailureReason,
    );
  }

  /** Emit a run.event to the Platform at an orchestrator lifecycle point. */
  private emitRunEvent(
    runId: string,
    eventType: string,
    opts?: {
      jobId?: string;
      metadata?: Record<string, unknown>;
      durationMs?: number;
    },
  ): void {
    // Gated on a bootstrapped orgId although orgId is not on the wire (tenant
    // attribution comes only from the Platform's authState.orgId; see
    // docs/architecture/security/ws-tenant-isolation.md): before bootstrap the
    // authState mapping of a non-platform-bound orchestrator can be ambiguous.
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
   * Emit a job's scaler lifecycle event: stored in event_log via the run.event
   * pipeline and written to the provisioning JSONL file.
   */
  emitScalerEvent(
    runId: string,
    jobId: string,
    event: { agentId: string; eventType: ScalerEventType; detail: string; timestampMs: number },
  ): void {
    // 1. run.event, for timeline rendering.
    this.emitRunEvent(runId, event.eventType, {
      jobId,
      metadata: {
        agentId: event.agentId,
        detail: event.detail,
        category: 'scaler',
      },
    });

    // 2. Live forward to Platform for run-detail streaming (provisioning phase),
    // in addition to persistence. Best-effort, gated on orgId like run.event.
    if (this.onOrchLog && this.orgId) {
      this.onOrchLog({
        runId,
        jobId,
        phase: OrchLogPhase.enum.provisioning,
        lines: [event.detail],
        ts: event.timestampMs,
      });
    }

    // 3. Provisioning log file, for the log viewer's provisioning section.
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

    // 4. On a failure, persist the detail to the dispatch_queue row so the
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
   * Append a JSONL line to a job's orchestration log
   * (executions/{runId}/jobs/{jobId}/orchestration.jsonl).
   */
  private writeOrchLog(runId: string, jobId: string, phase: OrchLogPhase, message: string): void {
    const ts = Date.now();
    // Best-effort live forward, gated on orgId like run.event so a
    // non-platform-bound orchestrator pushes no ambiguous tenant frames.
    if (this.onOrchLog && this.orgId) {
      this.onOrchLog({ runId, jobId, phase, lines: [message], ts });
    }
    if (!this.logStorage) return;
    const line = JSON.stringify({ ts, phase, message });
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
   * Human-readable description of a non-success run (its failed job names).
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

    return failedJobsSummary([...run.jobs.values()]);
  }

  /**
   * Overall run status from job statuses:
   * - success ONLY if ALL jobs pass (skipped jobs count as success)
   * - failed if ANY job ended in a failure status (see `STATUS_FAILURE_CLASS`)
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
      if (isFailureStatus(job.status)) {
        hasFailed = true;
      } else if (job.status === ExecutionJobStatus.enum.cancelled) {
        hasCancelled = true;
      }
    }

    if (hasFailed) return ExecutionRunStatus.enum.failed;
    if (hasCancelled) return ExecutionRunStatus.enum.cancelled;
    return ExecutionRunStatus.enum.success;
  }

  /**
   * Derive the failure class from a terminal run's job statuses; null for
   * success (and any non-terminal status). `timed_out_stale` / `drift_dropped`
   * / `unroutable` jobs (never dispatched, `runsOn` matched no agent, agent went
   * silent, or dropped by a topology reroute) are infra-class and collapse to
   * `timed_out`; any other `failed` run is a `step_failure`. `never_started`
   * (init failure) and `dead_orchestrator` (Platform-detected) are stamped by
   * their own paths.
   */
  // Deliberately narrower than `isFailureStatus`: an unroutable job as
  // `step_failure` would point the operator at logs of steps that never ran.
  private computeFailureClass(
    status: ExecutionRunStatus,
    jobs: Array<{ status: string }>,
  ): RunFailureClass | null {
    if (status === ExecutionRunStatus.enum.cancelled) return RunFailureClass.enum.cancelled;
    if (status !== ExecutionRunStatus.enum.failed) return null;
    const timedOut = jobs.some(
      (j) =>
        j.status === ExecutionJobStatus.enum.timed_out_stale ||
        j.status === ExecutionJobStatus.enum.drift_dropped ||
        j.status === ExecutionJobStatus.enum.unroutable,
    );
    return timedOut ? RunFailureClass.enum.timed_out : RunFailureClass.enum.step_failure;
  }
}
