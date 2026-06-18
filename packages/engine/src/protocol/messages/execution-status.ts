import { z } from 'zod';

// --- Execution status enums (single source of truth via Zod z.enum) ---
// Access values: ExecutionRunStatus.enum.pending, ExecutionJobStatus.enum.success, etc.
// Access type: ExecutionRunStatus (inferred string literal union)

/**
 * Status values for execution runs (execution_runs table).
 *
 * `held` = the run is paused at the workflow install gate (a `registries:` /
 * `installEnv:` protection rule returned hold/wait/queue). It is alive and
 * resumable — NOT terminal — so it is deliberately absent from
 * `TERMINAL_RUN_STATES`. On release (reviewer approve, wait-timer expiry,
 * concurrency slot free) the run resumes into job dispatch; on reject it
 * transitions to `cancelled`.
 */
export const ExecutionRunStatus = z.enum([
  'pending',
  'running',
  'success',
  'failed',
  'cancelled',
  'cancelling',
  'held',
]);
export type ExecutionRunStatus = z.infer<typeof ExecutionRunStatus>;

/** Status values for execution jobs (execution_jobs table + job.status protocol messages). */
export const ExecutionJobStatus = z.enum([
  'pending',
  'queued',
  'running',
  'recovering',
  'cancelling',
  'success',
  'failed',
  'cancelled',
  'skipped',
  'timed_out_stale',
  'drift_dropped',
]);
export type ExecutionJobStatus = z.infer<typeof ExecutionJobStatus>;

/** Status values for execution steps (execution_steps table + step.status protocol messages). */
export const ExecutionStepStatus = z.enum(['running', 'success', 'failed', 'skipped']);
export type ExecutionStepStatus = z.infer<typeof ExecutionStepStatus>;

/**
 * Distinct reasons a run/job ended because a configured wall-clock timeout
 * was exceeded. Surfaced in the failure/cancel reason so the dashboard can
 * label "timed out" instead of a generic failure.
 *
 *  - `job_timeout`      — a job exceeded its `timeout` (total job wall-clock,
 *                         agent-enforced in the forked workflow-runner).
 *  - `workflow_timeout` — a run exceeded the workflow `timeout` (whole-run
 *                         wall-clock, orchestrator-enforced run deadline).
 *
 * Step-level timeouts are reported inline in the step error message and do
 * NOT use this enum (they predate it and stay as-is).
 */
export const TimeoutReason = z.enum(['job_timeout', 'workflow_timeout']);
export type TimeoutReason = z.infer<typeof TimeoutReason>;

/**
 * Categories of init failure — i.e. failures that prevent a run from ever
 * executing a step. Set at the detection site (orchestrator or agent) and
 * persisted alongside the run/job row so the dashboard can render an
 * explanatory banner even when the orchestrator is offline.
 *
 * Scope is carried separately on `initFailureSchema.scope`:
 *  - `run`-scoped categories fail the whole run before any job runs
 *    (secret_resolution, install_secrets, lock_resolution,
 *    build_coordination).
 *  - `job`-scoped categories fail one job and leave siblings alone
 *    (environment_rules, dynamic_eval, no_agent, matrix_expansion).
 */
export const InitFailureCategory = z.enum([
  'secret_resolution',
  'install_secrets',
  'lock_resolution',
  'build_coordination',
  'environment_rules',
  'dynamic_eval',
  'no_agent',
  'matrix_expansion',
]);
export type InitFailureCategory = z.infer<typeof InitFailureCategory>;

/**
 * `step_type` values for the user-facing cache pseudo-steps that appear in the
 * run timeline. Mirrors the `hook:*` pseudo-step `step_type` convention: each
 * declarative job/step cache restore or save surfaces as one pseudo-step so the
 * dashboard can render it inline alongside the real steps.
 */
export const CacheStepType = z.enum(['cache:restore', 'cache:save']);
export type CacheStepType = z.infer<typeof CacheStepType>;

/** `run.event` types emitted for user-facing cache operations. */
export const CacheRunEventType = z.enum(['cache.restore', 'cache.save']);
export type CacheRunEventType = z.infer<typeof CacheRunEventType>;

/**
 * Outcome recorded on a cache pseudo-step (drives the pseudo-step status + the
 * `run.event` metadata).
 *
 *  - `hit`     — restore found an entry (exact key or restoreKeys prefix).
 *  - `miss`    — restore found nothing.
 *  - `saved`   — save uploaded a new entry under the immutable key.
 *  - `skipped` — save was a no-op (the immutable exact key already existed).
 *  - `error`   — the restore/save failed (pack/extract/transport error).
 */
export const CacheOutcome = z.enum(['hit', 'miss', 'saved', 'skipped', 'error']);
export type CacheOutcome = z.infer<typeof CacheOutcome>;

/** Structured init-failure signal. Presence on a run/job means "never started". */
export const initFailureSchema = z.object({
  scope: z.enum(['run', 'job']),
  category: InitFailureCategory,
  /** Human-readable failure message (same content surfaced by RunFailureSummary). */
  message: z.string(),
  /** Set when scope === 'job'. */
  jobName: z.string().optional(),
});
export type InitFailure = z.infer<typeof initFailureSchema>;

/** Terminal run states that indicate the run has completed. */
export const TERMINAL_RUN_STATES: ReadonlySet<string> = new Set<ExecutionRunStatus>([
  ExecutionRunStatus.enum.success,
  ExecutionRunStatus.enum.failed,
  ExecutionRunStatus.enum.cancelled,
]);

/** Terminal job states that indicate the job is no longer running. */
export const TERMINAL_JOB_STATES: ReadonlySet<string> = new Set<ExecutionJobStatus>([
  ExecutionJobStatus.enum.success,
  ExecutionJobStatus.enum.failed,
  ExecutionJobStatus.enum.cancelled,
  ExecutionJobStatus.enum.skipped,
  ExecutionJobStatus.enum.timed_out_stale,
  ExecutionJobStatus.enum.drift_dropped,
]);

// --- Orchestrator -> Platform: Execution status messages ---

/** Structured execution status update for Platform metadata tracking. */
export const executionStatusSchema = z.object({
  type: z.literal('execution.status'),
  messageId: z.string(),
  runId: z.string(),
  workflowName: z.string(),
  status: ExecutionRunStatus,
  repoIdentifier: z.string().optional(),
  sha: z.string().optional(),
  /** Git branch or tag (e.g. "main", "refs/tags/v1.0"). */
  ref: z.string().optional(),
  /** Trigger event type (e.g. "push", "pr:open"). */
  triggerEvent: z.string().optional(),
  /** First line of the commit message. */
  commitMessage: z.string().optional(),
  jobCount: z.number().optional(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  durationMs: z.number().optional(),
  timestamp: z.number(),
  /** Parent run ID for re-run lineage (null/undefined for original runs). */
  parentRunId: z.string().nullable().optional(),
  /** Root ancestor run ID for re-run lineage (null/undefined for original runs). Always points to the first run in the chain. */
  originalRunId: z.string().nullable().optional(),
  /** User identity that triggered this re-run (null/undefined for webhook-triggered). */
  triggeredBy: z.string().nullable().optional(),
  /** Human-readable reason why the run failed (only present for failed runs). */
  failureReason: z.string().optional(),
  /**
   * Total raw log bytes accumulated across all jobs of this run, summed by the
   * orchestrator from per-step `logBytesStreamed` values reported by the agent.
   * Only set on terminal run states. Powers the operator-side
   * `kici_org_log_bytes` capacity-planning gauge on the Platform.
   */
  logBytes: z.number().int().nonnegative().optional(),
  /**
   * Structured init-failure signal. Set by the orchestrator when the run
   * never executed a single step. Persisted in execution_runs.init_failure
   * on both orchestrator and Platform sides. Only present when status === 'failed'.
   */
  initFailure: initFailureSchema.optional(),
});

/** Per-step status forwarded from agent to Platform (real-time). */
export const stepStatusForwardSchema = z.object({
  type: z.literal('step.status.forward'),
  messageId: z.string(),
  runId: z.string(),
  jobId: z.string(),
  jobName: z.string(),
  stepIndex: z.number(),
  stepName: z.string(),
  state: ExecutionStepStatus,
  timestamp: z.number(),
  data: z.record(z.string(), z.unknown()).optional(),
  /** Secret key names accessed by this step. Forwarded from agent for dashboard display. */
  secretsAccessed: z.array(z.string()).optional(),
});

/** Per-job status forwarded from orchestrator to Platform (real-time). */
export const jobStatusForwardSchema = z.object({
  type: z.literal('job.status.forward'),
  messageId: z.string(),
  runId: z.string(),
  jobId: z.string(),
  jobName: z.string(),
  status: ExecutionJobStatus,
  matrixValues: z.record(z.string(), z.unknown()).optional(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  durationMs: z.number().optional(),
  errorMessage: z.string().nullable().optional(),
  agentId: z.string().nullable().optional(),
  orchestratorId: z.string().nullable().optional(),
  /** Labels used for agent routing. */
  runsOnLabels: z.array(z.string()).optional(),
  /**
   * Total raw log bytes accumulated across all steps of this job, summed by
   * the orchestrator from per-step `logBytesStreamed` values reported by the
   * agent. Only set on terminal job states. Powers the operator-side
   * `kici_org_log_bytes` capacity-planning gauge on the Platform.
   */
  logBytes: z.number().int().nonnegative().optional(),
  timestamp: z.number(),
  /** Structured init-failure signal — set for synthetic rejected-* / init-failed-* jobs. */
  initFailure: initFailureSchema.optional(),
});

/** State replay sent on orchestrator reconnection -- full snapshot of active runs and jobs. */
export const stateReplaySchema = z.object({
  type: z.literal('state.replay'),
  messageId: z.string(),
  runs: z.array(
    z.object({
      runId: z.string(),
      workflowName: z.string(),
      status: ExecutionRunStatus,
      routingKey: z.string().optional(),
      repoIdentifier: z.string().optional(),
      sha: z.string().optional(),
      ref: z.string().optional(),
      triggerEvent: z.string().optional(),
      commitMessage: z.string().optional(),
      jobCount: z.number(),
      startedAt: z.number(),
      completedAt: z.number().optional(),
      durationMs: z.number().optional(),
      parentRunId: z.string().nullable().optional(),
      originalRunId: z.string().nullable().optional(),
      triggeredBy: z.string().nullable().optional(),
      /** Human-readable reason why the run failed (only present for failed runs). */
      failureReason: z.string().optional(),
      jobs: z.array(
        z.object({
          jobId: z.string(),
          jobName: z.string(),
          status: z.string(),
          startedAt: z.number().optional(),
          completedAt: z.number().optional(),
          durationMs: z.number().optional(),
          errorMessage: z.string().nullable().optional(),
          agentId: z.string().nullable().optional(),
          runsOnLabels: z.array(z.string()).optional(),
        }),
      ),
    }),
  ),
  timestamp: z.number(),
});

// --- Inferred types ---

export type ExecutionStatus = z.infer<typeof executionStatusSchema>;
export type StepStatusForward = z.infer<typeof stepStatusForwardSchema>;
