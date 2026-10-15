import { z } from 'zod';

// --- Field-size bounds (flood hardening) ---
//
// A customer-controlled orchestrator can stream fabricated execution/job/replay
// messages; unbounded fields would let one message carry megabytes into the
// browser fan-out and DB writes. These ceilings bound the per-message blast
// radius, following `platform-orchestrator.ts` conventions.

/** Max length for ids and short identifier fields (runId, jobId, sha, ref, …). */
export const STATUS_ID_MAX = 128;
/** Max length for the repo identifier (`owner/repo`). */
export const REPO_IDENTIFIER_MAX = 256;
/** Max length for free-text fields (commit message, failure/error reason). */
export const STATUS_FREE_TEXT_MAX = 2000;
/** Max number of runs in a single `state.replay` snapshot. */
export const STATE_REPLAY_MAX_RUNS = 500;
/** Max number of jobs attached to a single run in a `state.replay` snapshot. */
export const MAX_JOBS_PER_RUN = 1000;
/** Max number of `runsOn` / `secretsAccessed` label entries on a job/step. */
export const RUNS_ON_LABELS_MAX = 30;
/** Max number of bound context names on a job. */
export const CONTEXTS_MAX = 30;

// --- Execution status enums (single source of truth) ---

/**
 * Status values for execution runs (execution_runs table).
 *
 * `held` = paused at the workflow install gate (a `registries:` / `installEnv:`
 * protection rule returned hold/wait/queue). It is resumable, NOT terminal, so
 * it is absent from `TERMINAL_RUN_STATES`. On release (reviewer approve,
 * wait-timer expiry, concurrency slot free) the run resumes into job dispatch;
 * on reject it becomes `cancelled`.
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

/**
 * Status values for execution jobs (execution_jobs table + job.status protocol messages).
 *
 * `unroutable` = `runsOn` matched no agent for the whole queue window, so the
 * job never ran: a fleet/label problem, unlike `failed` (ran, has logs),
 * `skipped` (a condition excluded it) or `timed_out_stale` (capacity existed
 * but never freed up).
 */
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
  'unroutable',
]);
export type ExecutionJobStatus = z.infer<typeof ExecutionJobStatus>;

/**
 * Job kind on the wire (mirrored by the orchestrator's DB `JobKind`): `standard`
 * runs steps on an agent; `gate` is an invoke gate that summons source-repo
 * runs instead; `proxy` mirrors one summoned run's lifecycle.
 */
export const JobKind = z.enum(['standard', 'gate', 'proxy']);
export type JobKind = z.infer<typeof JobKind>;

/**
 * The status values a notification subscription may target at a level:
 * `ExecutionRunStatus` for runs, `ExecutionJobStatus` (with job-only states
 * like `timed_out_stale` / `drift_dropped` / `skipped`) for jobs. Platform
 * validation and the dashboard editor both derive from it, so they cannot diverge.
 */
export function statusOptionsForLevel(level: 'run' | 'job'): readonly string[] {
  return level === 'job' ? ExecutionJobStatus.options : ExecutionRunStatus.options;
}

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
 * Why a run/job exceeded a configured wall-clock timeout, surfaced in the
 * failure/cancel reason so the dashboard can label "timed out".
 *
 *  - `job_timeout`      — a job exceeded its `timeout` (total job wall-clock,
 *                         agent-enforced in the forked workflow-runner).
 *  - `workflow_timeout` — a run exceeded the workflow `timeout` (whole-run
 *                         wall-clock, orchestrator-enforced run deadline).
 *
 * Step-level timeouts are reported inline in the step error message and do
 * NOT use this enum.
 */
export const TimeoutReason = z.enum(['job_timeout', 'workflow_timeout']);
export type TimeoutReason = z.infer<typeof TimeoutReason>;

/**
 * Categories of init failure (a run that never executes a step). Set at the
 * detection site (orchestrator or agent) and persisted on the run/job row, so
 * the dashboard can explain it even while the orchestrator is offline.
 *
 * Scope is carried separately on `initFailureSchema.scope`:
 *  - `run`-scoped categories fail the whole run before any job runs
 *    (secret_resolution, install_secrets, lock_resolution,
 *    build_coordination, approval_misconfig, sandbox_denied, trust_policy).
 *  - `job`-scoped categories fail one job and leave siblings alone
 *    (context_rules, dynamic_eval, no_agent, matrix_expansion).
 *  - `secret_resolution` is also job-scoped on a dynamically generated job
 *    whose own context gate failed; its siblings still dispatch.
 */
export const InitFailureCategory = z.enum([
  'secret_resolution',
  'install_secrets',
  'lock_resolution',
  'build_coordination',
  'context_rules',
  'dynamic_eval',
  'no_agent',
  'matrix_expansion',
  'approval_misconfig',
  'sandbox_denied',
  'trust_policy',
]);
export type InitFailureCategory = z.infer<typeof InitFailureCategory>;

/**
 * Why a terminal run failed (only meaningful for failed/cancelled runs):
 *  - never_started     — init failure (no_agent/secret/lock/build); no step ran.
 *  - timed_out         — a job timed out (never dispatched, or agent went silent).
 *  - dead_orchestrator — the Platform failed the run because its orchestrator died.
 *  - step_failure      — a job actually ran and failed.
 *  - cancelled         — the run was cancelled.
 *
 * Derived at run completion from terminal job statuses, since `timed_out` and
 * `step_failure` both collapse to run-status `failed`. The init-failure paths
 * stamp `never_started`; the Platform's dead-orchestrator detector stamps
 * `dead_orchestrator`.
 */
export const RunFailureClass = z.enum([
  'never_started',
  'timed_out',
  'dead_orchestrator',
  'step_failure',
  'cancelled',
]);
export type RunFailureClass = z.infer<typeof RunFailureClass>;

/**
 * `step_type` values for cache pseudo-steps in the run timeline. Like `hook:*`,
 * each declarative cache restore or save is one pseudo-step the dashboard
 * renders inline with the real steps.
 */
export const CacheStepType = z.enum(['cache:restore', 'cache:save']);
export type CacheStepType = z.infer<typeof CacheStepType>;

/**
 * `step_type` values for pseudo-steps that run BEFORE a job's real steps.
 *
 * The timeline orders by `step_index`, and every pseudo-step index sits ABOVE
 * the real steps (the wire requires a non-negative index; in-sandbox allocators
 * claim a high block). A job's image build runs strictly first, so readers sort
 * these types ahead of everything, by TYPE rather than index.
 *
 * Not a negative index: `step.status` rejects one outright (an older
 * orchestrator would close the agent's connection mid-job), and the check-run
 * reporter's array write and the dashboard's `stepIndex >= 0` log gate treat a
 * negative index as absent.
 */
export const SetupStepType = z.enum(['container:build']);
export type SetupStepType = z.infer<typeof SetupStepType>;

/** True when a `step_type` names a pseudo-step that ran before the real steps. */
export function isSetupStepType(stepType: string | null | undefined): boolean {
  return stepType != null && SetupStepType.safeParse(stepType).success;
}

/** `run.event` types emitted for user-facing cache operations. */
export const CacheRunEventType = z.enum(['cache.restore', 'cache.save']);
export type CacheRunEventType = z.infer<typeof CacheRunEventType>;

/**
 * Outcome of a cache pseudo-step; drives its status and the `run.event` metadata.
 *
 *  - `hit`     — restore found an entry (exact key or restoreKeys prefix).
 *  - `miss`    — restore found nothing.
 *  - `saved`   — save uploaded a new entry under the immutable key.
 *  - `skipped` — save was a no-op (the immutable exact key already existed).
 *  - `error`   — the restore/save failed (pack/extract/transport error).
 */
export const CacheOutcome = z.enum(['hit', 'miss', 'saved', 'skipped', 'error']);
export type CacheOutcome = z.infer<typeof CacheOutcome>;

/**
 * `execution_runs.failure_reason` the Platform stale-detector writes when a
 * run's orchestrator disconnected and did not reconnect within the stale
 * threshold; the dashboard matches it for the "stale / offline" badge.
 */
export const DEAD_ORCH_FAILURE_REASON = 'Orchestrator disconnected and did not recover';

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
  ExecutionJobStatus.enum.unroutable,
]);

/**
 * The type-level counterpart of `TERMINAL_JOB_STATES`.
 *
 * `Exclude<>` of the non-terminal statuses, never `Extract<>` of the terminal
 * ones: `Extract<>` does not widen when the enum gains a value, leaving an
 * exhaustive switch's `never` arm inert. `Exclude<>` widens, so a new status is
 * a compile error at every switch claiming to be total over the terminal set.
 */
export type TerminalJobStatus = Exclude<
  ExecutionJobStatus,
  'pending' | 'queued' | 'running' | 'recovering' | 'cancelling'
>;

/** Terminal step states that indicate the step is no longer running. */
export const TERMINAL_STEP_STATES: ReadonlySet<string> = new Set<ExecutionStepStatus>([
  ExecutionStepStatus.enum.success,
  ExecutionStepStatus.enum.failed,
  ExecutionStepStatus.enum.skipped,
  ExecutionStepStatus.enum.cancelled,
]);

// --- Orchestrator -> Platform: Execution status messages ---

/** Largest status generation a frame may carry: the Platform stores it in a 32-bit integer column. */
export const STATUS_EPOCH_MAX = 2_147_483_647;

/** A run's status generation — see `executionStatusSchema.statusEpoch`. */
const statusEpochSchema = z.number().int().nonnegative().max(STATUS_EPOCH_MAX);

/** Structured execution status update for Platform metadata tracking. */
export const executionStatusSchema = z.object({
  type: z.literal('execution.status'),
  messageId: z.string().max(STATUS_ID_MAX),
  runId: z.string().max(STATUS_ID_MAX),
  workflowName: z.string().max(STATUS_ID_MAX),
  status: ExecutionRunStatus,
  /**
   * Routing key of the run's own source, so the Platform mirror attributes runs
   * correctly when one orchestrator serves several sources. Absent → the
   * Platform falls back to the WS connection's first routing key.
   */
  routingKey: z.string().max(STATUS_ID_MAX).optional(),
  repoIdentifier: z.string().max(REPO_IDENTIFIER_MAX).optional(),
  /**
   * The repository that DEFINES the workflow, when not `repoIdentifier` (a
   * global workflow dispatched against another repository). Absent for every
   * per-repository run, so presence marks a cross-repository global run.
   */
  workflowRepoIdentifier: z.string().max(REPO_IDENTIFIER_MAX).optional(),
  /**
   * True when this run records a global evaluation round rather than a workflow.
   * The Platform mirrors it so its re-run refusal admits a round: a round is
   * cross-repository by definition, and re-running it re-evaluates the original
   * event instead of resolving a workflow from the acted-on repository's lock file.
   */
  isGlobalEvalRound: z.boolean().optional(),
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
  /** First run in the re-run chain (null/undefined for original runs). */
  originalRunId: z.string().max(STATUS_ID_MAX).nullable().optional(),
  /** User identity that triggered this re-run (null/undefined for webhook-triggered). */
  triggeredBy: z.string().max(STATUS_ID_MAX).nullable().optional(),
  /** Agent provenance label when the run was triggered through an agent credential. */
  triggeredByAgentLabel: z.string().max(STATUS_ID_MAX).nullable().optional(),
  /**
   * The provider event's actor (pusher / PR author), not `triggeredBy` (the KiCI
   * re-run user). Provider identities only, never tenant attribution (no `orgId`
   * on the wire). Powers "triggered by @x" and actor-scope notifications.
   * `triggerActorUsername` takes the wider repo-identifier bound because
   * provider logins can be long display names.
   */
  triggerActorProvider: z.string().max(STATUS_ID_MAX).nullable().optional(),
  triggerActorUsername: z.string().max(REPO_IDENTIFIER_MAX).nullable().optional(),
  triggerActorUserId: z.string().max(STATUS_ID_MAX).nullable().optional(),
  /** Human-readable reason why the run failed (only present for failed runs). */
  failureReason: z.string().max(STATUS_FREE_TEXT_MAX).optional(),
  /**
   * Raw log bytes across all jobs, summed by the orchestrator from the agent's
   * per-step `logBytesStreamed`. Set only on terminal states; feeds the
   * Platform's `kici_org_log_bytes` capacity-planning gauge.
   */
  logBytes: z.number().int().nonnegative().optional(),
  /**
   * Set when the run never executed a step; persisted in
   * execution_runs.init_failure on both sides. Only present when status === 'failed'.
   */
  initFailure: initFailureSchema.optional(),
  /** Why a terminal run failed (only present for failed/cancelled runs). */
  failureClass: RunFailureClass.optional(),
  /**
   * The run's status generation: starts at 0, and the orchestrator raises it each
   * time the run leaves a terminal status (it failed before an already-dispatched
   * job reported in, then continues). The Platform keeps a terminal status
   * against a non-terminal frame unless the frame's generation is newer, so a
   * late frame cannot move a finished run back.
   */
  statusEpoch: statusEpochSchema,
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
  /** Secret key names this step accessed, for dashboard display. */
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
  /** Ordered bound context names for this job (multi-context jobs). */
  contexts: z.array(z.string().max(STATUS_ID_MAX)).max(CONTEXTS_MAX).optional(),
  /**
   * Raw log bytes across this job's steps, set only on terminal job states; same
   * derivation and use as the run-level `logBytes`.
   */
  logBytes: z.number().int().nonnegative().optional(),
  timestamp: z.number(),
  /** Structured init-failure signal — set for synthetic rejected-* / init-failed-* jobs. */
  initFailure: initFailureSchema.optional(),
  /** Absent means `standard`; `gate`/`proxy` mark an invoke gate and its per-run proxy children. */
  jobKind: JobKind.optional(),
  /** For a `proxy` job, the summoned run it mirrors. Additive/optional. */
  summonedRunId: z.string().max(STATUS_ID_MAX).optional(),
});

/**
 * A single run's full mirror-projection shape in `state.replay`, consumed by the
 * Platform's shared `upsertRunMirror` helper.
 */
export const stateReplayRunSchema = z.object({
  runId: z.string().max(STATUS_ID_MAX),
  workflowName: z.string().max(STATUS_ID_MAX),
  status: ExecutionRunStatus,
  routingKey: z.string().max(STATUS_ID_MAX).optional(),
  repoIdentifier: z.string().max(REPO_IDENTIFIER_MAX).optional(),
  /**
   * Same contract as on `execution.status`; carried so a run that reaches the
   * Platform only through the reconnect replay keeps its attribution.
   */
  workflowRepoIdentifier: z.string().max(REPO_IDENTIFIER_MAX).optional(),
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
  triggeredByAgentLabel: z.string().max(STATUS_ID_MAX).nullable().optional(),
  /** Human-readable reason why the run failed (only present for failed runs). */
  failureReason: z.string().max(STATUS_FREE_TEXT_MAX).optional(),
  /** Why the run failed (`RunFailureClass`); only present for failed/cancelled runs. */
  failureClass: RunFailureClass.optional(),
  /** The run's status generation, with the same meaning as on `execution.status`. */
  statusEpoch: statusEpochSchema,
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
        runsOnLabels: z.array(z.string().max(STATUS_ID_MAX)).max(RUNS_ON_LABELS_MAX).optional(),
        contexts: z.array(z.string().max(STATUS_ID_MAX)).max(CONTEXTS_MAX).optional(),
      }),
    )
    .max(MAX_JOBS_PER_RUN),
});
export type StateReplayRun = z.infer<typeof stateReplayRunSchema>;

/** State replay sent on orchestrator reconnection: a full snapshot of active runs and jobs. */
export const stateReplaySchema = z.object({
  type: z.literal('state.replay'),
  messageId: z.string().max(STATUS_ID_MAX),
  runs: z.array(stateReplayRunSchema).max(STATE_REPLAY_MAX_RUNS),
  timestamp: z.number(),
});

// --- Inferred types ---

export type ExecutionStatus = z.infer<typeof executionStatusSchema>;
export type StepStatusForward = z.infer<typeof stepStatusForwardSchema>;
