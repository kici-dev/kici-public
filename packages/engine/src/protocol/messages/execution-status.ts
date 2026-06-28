import { z } from 'zod';

// --- Field-size bounds (flood hardening) ---
//
// A customer-controlled orchestrator can stream fabricated execution/job/replay
// messages into the Platform. Bare `z.string()` / unbounded arrays let a single
// message carry megabytes of attacker-chosen text and amplify into the browser
// fan-out + DB writes. These ceilings bound the per-message blast radius,
// mirroring the conventions in `platform-orchestrator.ts` (ids `.max(128)`,
// repo identifier `.max(256)`, free text `.max(2000)`, label arrays `.max(30)`).

/** Max length for ids and short identifier fields (runId, jobId, sha, ref, …). */
export const STATUS_ID_MAX = 128;
/** Max length for the repo identifier (`owner/repo` can be long). */
export const REPO_IDENTIFIER_MAX = 256;
/** Max length for free-text fields (commit message, failure/error reason). */
export const STATUS_FREE_TEXT_MAX = 2000;
/** Max number of runs in a single `state.replay` snapshot. */
export const STATE_REPLAY_MAX_RUNS = 500;
/** Max number of jobs attached to a single run in a `state.replay` snapshot. */
export const MAX_JOBS_PER_RUN = 1000;
/** Max number of `runsOn` / `secretsAccessed` label entries on a job/step. */
export const RUNS_ON_LABELS_MAX = 30;
/** Max number of bound deployment-environment names on a job. */
export const ENVIRONMENTS_MAX = 30;

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

/**
 * Status values for execution steps (execution_steps table + step.status protocol messages).
 *
 *  - `pending`   — a parallel-group child queued behind `maxParallel`, not yet launched.
 *  - `cancelled` — a parallel-group sibling aborted by fail-fast (NOT a failure).
 */
export const ExecutionStepStatus = z.enum([
  'running',
  'success',
  'failed',
  'skipped',
  'pending',
  'cancelled',
]);
export type ExecutionStepStatus = z.infer<typeof ExecutionStepStatus>;

/**
 * How a step participates in a job's step concurrency model.
 *
 *  - `sequential`     — an ordinary step in the flat step sequence.
 *  - `parallel-child` — a child of a `parallel()` group, running concurrently
 *                       with its siblings, each its own observable step.
 *  - `parallel-group` — the structural group wrapper (no flat step index); used
 *                       only for the dashboard band aggregate, not persisted per step.
 */
export const StepConcurrencyKind = z.enum(['sequential', 'parallel-child', 'parallel-group']);
export type StepConcurrencyKind = z.infer<typeof StepConcurrencyKind>;

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
  message: z.string().max(STATUS_FREE_TEXT_MAX),
  /** Set when scope === 'job'. */
  jobName: z.string().max(STATUS_ID_MAX).optional(),
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
  messageId: z.string().max(STATUS_ID_MAX),
  runId: z.string().max(STATUS_ID_MAX),
  workflowName: z.string().max(STATUS_ID_MAX),
  status: ExecutionRunStatus,
  repoIdentifier: z.string().max(REPO_IDENTIFIER_MAX).optional(),
  /**
   * Run-level repo provider (origin host: `github` / `gitlab` / `bitbucket` /
   * `local`). Distinct from the routing-key-derived source provider; drives the
   * dashboard's provider-aware repo links.
   */
  repoProvider: z.string().max(STATUS_ID_MAX).optional(),
  /** True when the run executed a developer's uploaded local working tree (`kici run remote`). */
  localWorkingTree: z.boolean().optional(),
  sha: z.string().max(STATUS_ID_MAX).optional(),
  /** Git branch or tag (e.g. "main", "refs/tags/v1.0"). */
  ref: z.string().max(STATUS_ID_MAX).optional(),
  /** Trigger event type (e.g. "push", "pr:open"). */
  triggerEvent: z.string().max(STATUS_ID_MAX).optional(),
  /** First line of the commit message. */
  commitMessage: z.string().max(STATUS_FREE_TEXT_MAX).optional(),
  jobCount: z.number().optional(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  durationMs: z.number().optional(),
  timestamp: z.number(),
  /** Parent run ID for re-run lineage (null/undefined for original runs). */
  parentRunId: z.string().max(STATUS_ID_MAX).nullable().optional(),
  /** Root ancestor run ID for re-run lineage (null/undefined for original runs). Always points to the first run in the chain. */
  originalRunId: z.string().max(STATUS_ID_MAX).nullable().optional(),
  /** User identity that triggered this re-run (null/undefined for webhook-triggered). */
  triggeredBy: z.string().max(STATUS_ID_MAX).nullable().optional(),
  /**
   * Triggering-actor identity captured from the provider event (the pusher / PR
   * author), distinct from `triggeredBy` (the KiCI re-run user). Provider
   * identities only — never tenant attribution (the wire-schema invariant: no
   * `orgId` here). Powers the dashboard "triggered by @x" and actor-scope
   * notifications. `triggerActorUsername` uses the wider repo-identifier bound
   * because provider logins can be long display names.
   */
  triggerActorProvider: z.string().max(STATUS_ID_MAX).nullable().optional(),
  triggerActorUsername: z.string().max(REPO_IDENTIFIER_MAX).nullable().optional(),
  triggerActorUserId: z.string().max(STATUS_ID_MAX).nullable().optional(),
  /** Human-readable reason why the run failed (only present for failed runs). */
  failureReason: z.string().max(STATUS_FREE_TEXT_MAX).optional(),
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
  messageId: z.string().max(STATUS_ID_MAX),
  runId: z.string().max(STATUS_ID_MAX),
  jobId: z.string().max(STATUS_ID_MAX),
  jobName: z.string().max(STATUS_ID_MAX),
  stepIndex: z.number(),
  stepName: z.string().max(REPO_IDENTIFIER_MAX),
  state: ExecutionStepStatus,
  timestamp: z.number(),
  data: z.record(z.string().max(STATUS_ID_MAX), z.unknown()).optional(),
  /** Secret key names accessed by this step. Forwarded from agent for dashboard display. */
  secretsAccessed: z.array(z.string().max(STATUS_ID_MAX)).max(RUNS_ON_LABELS_MAX).optional(),
  /** Step concurrency role; absent means an ordinary sequential step. */
  concurrencyKind: StepConcurrencyKind.optional(),
  /** Parallel-group correlation id shared by a group's children (e.g. `g0`). */
  groupId: z.string().max(STATUS_ID_MAX).optional(),
});

/** Per-job status forwarded from orchestrator to Platform (real-time). */
export const jobStatusForwardSchema = z.object({
  type: z.literal('job.status.forward'),
  messageId: z.string().max(STATUS_ID_MAX),
  runId: z.string().max(STATUS_ID_MAX),
  jobId: z.string().max(STATUS_ID_MAX),
  jobName: z.string().max(STATUS_ID_MAX),
  status: ExecutionJobStatus,
  matrixValues: z.record(z.string().max(STATUS_ID_MAX), z.unknown()).optional(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  durationMs: z.number().optional(),
  errorMessage: z.string().max(STATUS_FREE_TEXT_MAX).nullable().optional(),
  agentId: z.string().max(STATUS_ID_MAX).nullable().optional(),
  orchestratorId: z.string().max(STATUS_ID_MAX).nullable().optional(),
  /** Labels used for agent routing. */
  runsOnLabels: z.array(z.string().max(STATUS_ID_MAX)).max(RUNS_ON_LABELS_MAX).optional(),
  /** Ordered bound deployment-environment names for this job (multi-env jobs). */
  environments: z.array(z.string().max(STATUS_ID_MAX)).max(ENVIRONMENTS_MAX).optional(),
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
  messageId: z.string().max(STATUS_ID_MAX),
  runs: z
    .array(
      z.object({
        runId: z.string().max(STATUS_ID_MAX),
        workflowName: z.string().max(STATUS_ID_MAX),
        status: ExecutionRunStatus,
        routingKey: z.string().max(STATUS_ID_MAX).optional(),
        repoIdentifier: z.string().max(REPO_IDENTIFIER_MAX).optional(),
        sha: z.string().max(STATUS_ID_MAX).optional(),
        ref: z.string().max(STATUS_ID_MAX).optional(),
        triggerEvent: z.string().max(STATUS_ID_MAX).optional(),
        commitMessage: z.string().max(STATUS_FREE_TEXT_MAX).optional(),
        jobCount: z.number(),
        startedAt: z.number(),
        completedAt: z.number().optional(),
        durationMs: z.number().optional(),
        parentRunId: z.string().max(STATUS_ID_MAX).nullable().optional(),
        originalRunId: z.string().max(STATUS_ID_MAX).nullable().optional(),
        triggeredBy: z.string().max(STATUS_ID_MAX).nullable().optional(),
        /** Human-readable reason why the run failed (only present for failed runs). */
        failureReason: z.string().max(STATUS_FREE_TEXT_MAX).optional(),
        jobs: z
          .array(
            z.object({
              jobId: z.string().max(STATUS_ID_MAX),
              jobName: z.string().max(STATUS_ID_MAX),
              status: z.string().max(STATUS_ID_MAX),
              startedAt: z.number().optional(),
              completedAt: z.number().optional(),
              durationMs: z.number().optional(),
              errorMessage: z.string().max(STATUS_FREE_TEXT_MAX).nullable().optional(),
              agentId: z.string().max(STATUS_ID_MAX).nullable().optional(),
              runsOnLabels: z
                .array(z.string().max(STATUS_ID_MAX))
                .max(RUNS_ON_LABELS_MAX)
                .optional(),
              environments: z.array(z.string().max(STATUS_ID_MAX)).max(ENVIRONMENTS_MAX).optional(),
            }),
          )
          .max(MAX_JOBS_PER_RUN),
      }),
    )
    .max(STATE_REPLAY_MAX_RUNS),
  timestamp: z.number(),
});

// --- Inferred types ---

export type ExecutionStatus = z.infer<typeof executionStatusSchema>;
export type StepStatusForward = z.infer<typeof stepStatusForwardSchema>;
