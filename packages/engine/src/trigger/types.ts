/**
 * Lock file types for the trigger matching engine.
 * Single source of truth -- replaces local copies in @kici-dev/compiler and @kici-dev/orchestrator.
 * Schema version 4: adds 4 internal event routing trigger types (kici_event, workflow_complete,
 * job_complete, generic_webhook).
 * Schema version 6: replaces job-level contexts with environment/env/concurrencyGroup.
 * Schema version 8: adds runsOn polymorphic type (string | string[] | selector) and excludeLabels.
 * Schema version 9: adds repos/notRepos repo pattern fields to git-event triggers for global workflow matching.
 * Schema version 10: removes notRepos/notPaths fields, negative patterns use ! prefix in repos/paths arrays.
 * Schema version 11: adds LockInlineValue type for pure function inline evaluation.
 * Schema version 14: adds declarative cache specs to LockJob and LockStep.
 * Schema version 15: adds per-job init config(s) to LockJob.
 * Schema version 16: adds normalized approval config to LockWorkflow/LockJob/LockStep.
 * Schema version 17: widens LockJob.init to typed presets ('mise' / { mise }) and 'auto' detection.
 * Schema version 18: adds LockJob.runsOnAll host fan-out predicate + onUnreachable policy.
 * Schema version 19: adds LockJob.maxParallel/failFast fan-out concurrency (rolling waves).
 * Schema version 20: runsOn/runsOnAll/excludeLabels carry LabelMatcher (exact|regex) for glob+regex selectors.
 */

import { z } from 'zod';
import type { ProviderType } from '../provider/types.js';
import type { ApproverClause } from '../approval/types.js';
import { LabelMatcher } from '../labels-match.js';
import { ExecutionJobStatus, TERMINAL_JOB_STATES } from '../protocol/messages/execution-status.js';

/** Schema version - increment on breaking changes */
export const SCHEMA_VERSION = 22 as const;

/**
 * Normalized approval config carried in the lock file. Produced by the compiler
 * from an SDK `approval` at any of the three levels; consumed by the
 * orchestrator dispatch gate (and the agent step round-trip for step scope).
 */
export interface LockApproval {
  /** AND list of approver clauses; empty means "any approval-capable member". */
  readonly clauses: ApproverClause[];
  /** Human label for the gate. */
  readonly reason?: string;
  /** Per-gate expiry override (seconds); falls back to the org default. */
  readonly timeoutSeconds?: number;
  /**
   * When the gate fires. `always` (default) gates before the element; `drift`
   * gates between a step's check and run on detected drift (step scope only).
   */
  readonly when: 'always' | 'drift';
}

/**
 * Source file reference with meaningful path.
 * Format: file is relative path from git root, export uses hash syntax.
 */
export interface LockSource {
  /** Relative path from repo root: .kici/workflows/ci.ts */
  readonly file: string;
  /** Export name with hash syntax: #build or #default or #default[0] */
  readonly export: string;
}

/** Branch pattern in lock file */
export interface LockBranchPattern {
  readonly type: 'glob' | 'regex';
  readonly pattern: string;
  readonly flags?: string; // Only for regex
}

/**
 * PR trigger in lock file.
 * Optimized for orchestrator event matching - flat structure with all filters accessible.
 */
export interface LockPrTrigger {
  readonly _type: 'pr';
  readonly events: readonly string[];
  readonly targetBranches: readonly LockBranchPattern[];
  readonly sourceBranches: readonly LockBranchPattern[];
  readonly paths: readonly string[];
  readonly repos?: readonly LockBranchPattern[];
}

/**
 * Push trigger in lock file.
 * Optimized for orchestrator event matching - flat structure with all filters accessible.
 */
export interface LockPushTrigger {
  readonly _type: 'push';
  readonly branches: readonly LockBranchPattern[];
  readonly paths: readonly string[];
  readonly repos?: readonly LockBranchPattern[];
}

/**
 * Tag trigger in lock file.
 * Matches tag push events. Reuses LockBranchPattern for tag name patterns.
 */
export interface LockTagTrigger {
  readonly _type: 'tag';
  readonly patterns: readonly LockBranchPattern[];
  readonly repos?: readonly LockBranchPattern[];
}

/**
 * Comment trigger in lock file.
 * Matches issue_comment and pull_request_review_comment events.
 */
export interface LockCommentTrigger {
  readonly _type: 'comment';
  readonly actions: readonly string[];
  readonly source?: 'issue' | 'pr';
  readonly bodyMatch?: {
    readonly pattern: string;
    readonly type: 'glob' | 'regex';
    readonly flags?: string;
  };
  readonly repos?: readonly LockBranchPattern[];
}

/**
 * Review trigger in lock file.
 * Matches pull_request_review events.
 */
export interface LockReviewTrigger {
  readonly _type: 'review';
  readonly actions: readonly string[];
  readonly states: readonly string[];
  readonly repos?: readonly LockBranchPattern[];
}

/**
 * Review comment trigger in lock file.
 * Matches pull_request_review_comment events.
 */
export interface LockReviewCommentTrigger {
  readonly _type: 'review_comment';
  readonly actions: readonly string[];
  readonly repos?: readonly LockBranchPattern[];
}

/**
 * Release trigger in lock file.
 * Matches release events (published, created, etc.).
 */
export interface LockReleaseTrigger {
  readonly _type: 'release';
  readonly actions: readonly string[];
  readonly repos?: readonly LockBranchPattern[];
}

/**
 * Dispatch trigger in lock file.
 * Matches repository_dispatch events by type.
 */
export interface LockDispatchTrigger {
  readonly _type: 'dispatch';
  readonly types: readonly string[];
  readonly repos?: readonly LockBranchPattern[];
}

/**
 * Create trigger in lock file.
 * Matches create events (branch or tag creation).
 */
export interface LockCreateTrigger {
  readonly _type: 'create';
  readonly refTypes: readonly ('branch' | 'tag')[];
  readonly patterns: readonly LockBranchPattern[];
  readonly repos?: readonly LockBranchPattern[];
}

/**
 * Delete trigger in lock file.
 * Matches delete events (branch or tag deletion).
 */
export interface LockDeleteTrigger {
  readonly _type: 'delete';
  readonly refTypes: readonly ('branch' | 'tag')[];
  readonly patterns: readonly LockBranchPattern[];
  readonly repos?: readonly LockBranchPattern[];
}

/**
 * Status trigger in lock file.
 * Matches status events (commit status updates).
 */
export interface LockStatusTrigger {
  readonly _type: 'status';
  readonly contexts: readonly string[]; // picomatch patterns
  readonly states: readonly string[];
  readonly repos?: readonly LockBranchPattern[];
}

/**
 * Workflow run trigger in lock file.
 * Matches workflow_run events.
 */
export interface LockWorkflowRunTrigger {
  readonly _type: 'workflow_run';
  readonly actions: readonly string[];
  readonly workflows: readonly string[];
  readonly conclusions: readonly string[];
  readonly repos?: readonly LockBranchPattern[];
}

/**
 * Fork trigger in lock file.
 * Matches fork events. No filter fields.
 */
export interface LockForkTrigger {
  readonly _type: 'fork';
  readonly repos?: readonly LockBranchPattern[];
}

/**
 * Star trigger in lock file.
 * Matches star (watch) events.
 */
export interface LockStarTrigger {
  readonly _type: 'star';
  readonly actions: readonly string[];
  readonly repos?: readonly LockBranchPattern[];
}

/**
 * Watch trigger in lock file.
 * Matches watch events (GitHub "started watching" activity).
 */
export interface LockWatchTrigger {
  readonly _type: 'watch';
  readonly actions: readonly string[];
  readonly repos?: readonly LockBranchPattern[];
}

/**
 * Generic webhook trigger in lock file.
 * Matches arbitrary webhook events not covered by specific trigger types.
 */
export interface LockWebhookTrigger {
  readonly _type: 'webhook';
  readonly events: readonly string[];
  readonly actions: readonly string[];
  readonly repos?: readonly LockBranchPattern[];
}

/**
 * KiCI internal event trigger in lock file.
 * Matches custom named events emitted via ctx.emit() from within steps.
 * Supports JSONPath payload matching via match/not expressions.
 */
export interface LockKiciEventTrigger {
  readonly _type: 'kici_event';
  readonly eventName: string;
  readonly match?: Record<string, unknown>;
  readonly not?: Record<string, unknown>;
  readonly source?: string;
}

/**
 * Workflow completion trigger in lock file.
 * Matches when a workflow finishes execution (success, failed, cancelled).
 */
export interface LockWorkflowCompleteTrigger {
  readonly _type: 'workflow_complete';
  readonly name?: string;
  readonly status?: readonly string[];
  readonly source?: string;
}

/**
 * Job completion trigger in lock file.
 * Matches when a specific job within a workflow finishes execution.
 */
export interface LockJobCompleteTrigger {
  readonly _type: 'job_complete';
  readonly workflow?: string;
  readonly job?: string;
  readonly status?: readonly string[];
  readonly source?: string;
}

/**
 * Auth configuration for generic webhook verification in lock file.
 */
export interface LockGenericWebhookAuth {
  readonly method: 'hmac-sha256' | 'api-key';
  readonly secret: string;
  /** For HMAC: header containing signature */
  readonly signatureHeader?: string;
  /** For API key: header to check (default 'authorization') */
  readonly header?: string;
}

/**
 * Generic webhook ingestion trigger in lock file.
 * Matches webhooks from non-Git sources (external services, APIs, etc.).
 * Supports JSONPath payload matching via match/not expressions.
 */
export interface LockGenericWebhookTrigger {
  readonly _type: 'generic_webhook';
  readonly source: string;
  readonly events?: readonly string[];
  readonly match?: Record<string, unknown>;
  readonly not?: Record<string, unknown>;
  readonly auth?: LockGenericWebhookAuth;
  /** URL path pattern for routing */
  readonly path?: string;
}

/**
 * Schedule trigger in lock file.
 * Matches cron-based events fired by the scheduler.
 */
export interface LockScheduleTrigger {
  readonly _type: 'schedule';
  readonly cronExpression: string;
  readonly timezone: string;
  readonly description?: string;
}

/**
 * Lifecycle trigger in lock file.
 * Matches cross-workflow lifecycle events (workflow_complete, job_complete, etc.).
 */
export interface LockLifecycleTrigger {
  readonly _type: 'lifecycle';
  readonly events: readonly string[];
  readonly sources?: readonly string[];
  readonly description?: string;
}

/** Union of all trigger types */
export type LockTrigger =
  | LockPrTrigger
  | LockPushTrigger
  | LockTagTrigger
  | LockCommentTrigger
  | LockReviewTrigger
  | LockReviewCommentTrigger
  | LockReleaseTrigger
  | LockDispatchTrigger
  | LockCreateTrigger
  | LockDeleteTrigger
  | LockStatusTrigger
  | LockWorkflowRunTrigger
  | LockForkTrigger
  | LockStarTrigger
  | LockWatchTrigger
  | LockWebhookTrigger
  | LockKiciEventTrigger
  | LockWorkflowCompleteTrigger
  | LockJobCompleteTrigger
  | LockGenericWebhookTrigger
  | LockScheduleTrigger
  | LockLifecycleTrigger;

/**
 * Matrix configuration in lock file.
 * Static matrices are expanded at orchestrator, dynamic at agent runtime.
 */
export interface LockMatrix {
  readonly _type: 'static' | 'dynamic';
  /** Static values (only when _type is 'static') */
  readonly values?: Record<string, readonly string[]> | readonly string[];
  /** Source reference for dynamic matrices */
  readonly source?: {
    readonly file: string;
    readonly jobName: string;
  };
}

/**
 * Rule reference in lock file.
 * Rules are always dynamic - they contain check functions evaluated at agent runtime.
 */
export interface LockRule {
  readonly _type: 'dynamic'; // Rules are always dynamic (contain check functions)
  readonly label: string;
  readonly source: {
    readonly file: string;
    readonly index: number; // Rule index in workflow/job rules array
  };
}

/**
 * Step in lock file.
 * Minimal representation - agents load full step functions from source.
 */
export interface LockStep {
  readonly name: string;
  readonly hasOutputs: boolean;
  /** When true, job proceeds even if this step fails. */
  readonly continueOnError?: boolean;
  /** Step-level timeout in milliseconds. */
  readonly timeout?: number;
  /** Source location of the step() call in the original TypeScript file (for annotations). */
  readonly sourceLocation?: {
    readonly file: string;
    readonly line: number;
    readonly column: number;
  };
  /** Normalized approval gate; when set the step pauses for a human approval. */
  readonly approval?: LockApproval;
}

/**
 * Inline expression value for pure dynamic functions.
 * The compiler serializes pure functions as { _type: 'inline', expression: '(event) => ...' }
 * and the orchestrator evaluates them via vm.runInNewContext at dispatch time.
 * struct with discriminant and expression field.
 * _type: 'inline' alongside existing 'static' and 'dynamic' discriminants.
 */
export interface LockInlineValue {
  readonly _type: 'inline';
  readonly expression: string;
}

/** Type guard for inline expression values */
export function isLockInlineValue(value: unknown): value is LockInlineValue {
  return (
    typeof value === 'object' && value !== null && (value as LockInlineValue)._type === 'inline'
  );
}

/**
 * Author-facing keyword sugar for a `needs` edge's run condition. Each keyword
 * resolves (at compile time) to a set of upstream terminal statuses; the
 * downstream edge is dispatch-satisfied when the upstream's terminal status is
 * a member of that set.
 */
export const NeedsWhen = z.enum(['on-success', 'always', 'on-skip', 'on-failure']);
export type NeedsWhen = z.infer<typeof NeedsWhen>;

/**
 * Normalized, DB-evaluable run condition for a `needs` edge: the non-empty set
 * of upstream terminal statuses that satisfy the edge. The lock file and the
 * orchestrator scheduler only ever see this resolved set (never a keyword), so
 * gating stays a pure status-set membership test.
 */
export const NeedsRunOn = z.array(ExecutionJobStatus).nonempty();
export type NeedsRunOn = z.infer<typeof NeedsRunOn>;

const WHEN_TO_RUN_ON: Record<NeedsWhen, ExecutionJobStatus[]> = {
  'on-success': [ExecutionJobStatus.enum.success],
  always: [...TERMINAL_JOB_STATES] as ExecutionJobStatus[],
  'on-skip': [ExecutionJobStatus.enum.success, ExecutionJobStatus.enum.skipped],
  'on-failure': [ExecutionJobStatus.enum.failed, ExecutionJobStatus.enum.timed_out_stale],
};

/**
 * Resolve the author-facing `when` (keyword sugar | raw status-set | unset) to
 * the normalized status-set. An unset `when` defaults to success-only — the
 * downstream runs only when the upstream succeeded.
 */
export function resolveWhenToRunOn(
  when: NeedsWhen | ExecutionJobStatus[] | undefined,
): ExecutionJobStatus[] {
  if (when === undefined) return [ExecutionJobStatus.enum.success];
  if (Array.isArray(when)) return when;
  return WHEN_TO_RUN_ON[when];
}

/**
 * Needs entry carrying the normalized run-on status-set.
 * Used in lock file needs arrays for an explicit per-edge run condition.
 */
export const NeedsEntrySchema = z.object({
  name: z.string(),
  runOn: NeedsRunOn.default([ExecutionJobStatus.enum.success]),
});
export type NeedsEntry = z.infer<typeof NeedsEntrySchema>;

/**
 * Needs group entry carrying the normalized run-on status-set.
 * Used in lock file needs arrays for dynamic group dependencies.
 */
export const NeedsGroupEntrySchema = z.object({
  group: z.string(),
  runOn: NeedsRunOn.default([ExecutionJobStatus.enum.success]),
});
export type NeedsGroupEntry = z.infer<typeof NeedsGroupEntrySchema>;

/**
 * Static job in lock file.
 * Contains all orchestrator-readable information for scheduling.
 */
/** Normalized runsOnAll predicate: OR of AND-groups (include), minus exclude matchers. */
export interface RunsOnAllPredicate {
  /** OR across groups; AND within a group. */
  readonly include: readonly (readonly LabelMatcher[])[];
  /** Matchers that disqualify a host (AND-NOT, applied to the union). */
  readonly exclude: readonly LabelMatcher[];
}

/** Author-facing input forms for runsOnAll (string | RegExp | array-with-! | structured). */
export type RunsOnAllInput =
  | string
  | RegExp
  | readonly (string | RegExp)[]
  | {
      readonly include: readonly { readonly all: readonly (string | RegExp)[] }[];
      readonly exclude?: readonly (string | RegExp)[];
    };

/**
 * Failure policy for a host fan-out (`runsOnAll`) when an expected durable host
 * is in the declared roster but not currently reachable.
 *
 * - `skip`: omit the unreachable durable host (fan out to reachable hosts only).
 * - `fail`: fail the run init if any expected durable host is unreachable.
 * - `hold`: queue a pinned child for each unreachable durable host and wait for
 *   it to (re)connect (the durable default).
 *
 * Ephemeral hosts that are not live are always skipped (a scaled-down node may
 * never return), independent of this policy.
 */
export const OnUnreachableMode = z.enum(['skip', 'fail', 'hold']);
export type OnUnreachableMode = z.infer<typeof OnUnreachableMode>;

export interface LockJob {
  readonly _type: 'static';
  readonly name: string;
  /** Single-agent targeting matchers. Absent when the job uses `runsOnAll` instead. */
  readonly runsOn?: readonly LabelMatcher[];
  readonly excludeLabels?: readonly LabelMatcher[];
  /**
   * Host fan-out predicate (mutually exclusive with `runsOn`). When set, the job
   * fans out to every roster host matching the predicate, one pinned child per host.
   */
  readonly runsOnAll?: RunsOnAllPredicate;
  /** Failure policy for unreachable durable hosts in a `runsOnAll` fan-out. */
  readonly onUnreachable?: OnUnreachableMode;
  /**
   * Fan-out concurrency width (sliding window; `1` = serial). When set on a
   * fan-out job (matrix or `runsOnAll`), only the first `maxParallel` children
   * dispatch; the rest are held `wave_gated` and released one-per-terminal.
   */
  readonly maxParallel?: number;
  /** Halt the fan-out on first child failure, skipping the held remainder. Default `false`. */
  readonly failFast?: boolean;
  readonly needs: readonly (string | NeedsEntry | NeedsGroupEntry)[];
  /** Group names this job depends on (populated by compiler from dynamicGroup refs). */
  readonly dependsOnGroups?: readonly string[];
  readonly steps: readonly LockStep[];
  readonly matrix?: LockMatrix;
  readonly include?: readonly Record<string, string>[];
  readonly exclude?: readonly Record<string, string>[];
  readonly rules?: readonly LockRule[];
  readonly description?: string;
  /** Deployment environment name (static string) or inline expression (pure function). */
  readonly environment?: string | LockInlineValue;
  /** When true, environment is dynamic (function) -- resolved at orchestrator two-phase eval or inline. */
  readonly dynamicEnvironment?: boolean;
  /** Static environment variables or inline expression (pure function). */
  readonly env?: Record<string, string> | LockInlineValue;
  /** When true, env is dynamic (function) -- resolved at orchestrator two-phase eval or inline. */
  readonly dynamicEnv?: boolean;
  /** Concurrency group name (static string) or inline expression (pure function). */
  readonly concurrencyGroup?: string | LockInlineValue;
  /** When true, concurrencyGroup is dynamic (function) -- resolved at orchestrator two-phase eval or inline. */
  readonly dynamicConcurrencyGroup?: boolean;
  /** Total job wall-clock timeout in milliseconds (init + all steps + hooks). Threaded to the agent via jobConfig. */
  readonly timeout?: number;
  /**
   * Resource request and limit for this job.
   * Threaded from SDK `Job.resources` to the orchestrator scaler for cap accounting
   * (`requests`) and kernel-side enforcement (`limits`) on the spawned agent.
   */
  readonly resources?: import('../scaler/resource-types.js').ResourceRequest;
  /** Normalized approval gate; when set the job is held before dispatch. */
  readonly approval?: LockApproval;
}

/**
 * Dynamic job generator reference.
 * Points to async function that generates jobs at agent runtime.
 */
export interface LockDynamicJobFn {
  readonly _type: 'dynamic';
  readonly source: {
    readonly file: string;
    readonly index: number; // Index in jobs array
  };
  /** Group name for cross-domain needs (set when dynamicJob('name', fn) is used). */
  readonly group?: string;
  /**
   * Declared upstream needs for a result-aware generator. When present the
   * generator's eval job is deferred until these upstreams complete, then run
   * with their frozen outputs available as ctx.needs. Same normalized shape as
   * a static job's `needs`.
   */
  readonly needs?: readonly (string | NeedsEntry | NeedsGroupEntry)[];
  /** True when this dynamic entry was authored as dynamicJob(group, { needs, generate }). */
  readonly resultAware?: boolean;
}

/** Job or dynamic job generator */
export type LockJobOrFactory = LockJob | LockDynamicJobFn;

/**
 * Private npm registry declaration in the lock file.
 * Carries the URL/scope/secret-reference but NOT the resolved token —
 * the orchestrator resolves the token at dispatch time via the per-environment
 * secretResolver.resolveForJob path.
 */
export interface LockRegistry {
  readonly url: string;
  readonly scope?: string;
  /** Qualified secret reference: `<environment>:<secret-name>`. */
  readonly tokenSecret: string;
  readonly alwaysAuth?: boolean;
}

/**
 * Workflow in lock file.
 * Complete workflow definition ready for orchestrator consumption.
 */
export interface LockWorkflow {
  readonly name: string;
  /** Per-workflow source file reference. Required when workflows span multiple files. */
  readonly source?: LockSource;
  /** SHA-256 content hash of the compiled bundle (and optional hashFiles contents) mixed with compileSchemaVersion */
  readonly contentHash: string;
  /** Compile schema version used when computing the content hash */
  readonly compileSchemaVersion: number;
  readonly triggers: readonly LockTrigger[];
  readonly jobs: readonly LockJobOrFactory[];
  readonly rules?: readonly LockRule[];
  readonly description?: string;
  /** Declared hashFiles patterns from the workflow (paths/globs relative to repo root). Optional. */
  readonly hashFiles?: string[];
  /** Resolved paths (relative to repo root) used to compute contentHash. Enables agent to verify hash without re-discovering workflow. Optional. */
  readonly resolvedHashFiles?: string[];
  /** Secret contexts declared by the workflow. Orchestrator validates access before dispatch. Optional. */
  readonly contexts?: readonly string[];
  /**
   * Private npm registries the agent should authenticate against before `npm install`.
   * Resolved-token bytes never appear in the lock file; only the secret reference does.
   */
  readonly registries?: readonly LockRegistry[];
  /**
   * Extra qualified secret refs (`<environment>:<secret-name>`) to project as
   * env vars on the install subprocess for use with a customer-committed `.kici/.npmrc`.
   */
  readonly installEnv?: readonly string[];
  /** Workflow-level concurrency configuration. */
  readonly concurrency?: {
    readonly hasGroup: boolean;
    readonly cancelInProgress?: boolean;
    readonly max?: number;
  };
  /** Whole-run wall-clock timeout in milliseconds. Read by the orchestrator at run creation to set the run deadline. */
  readonly timeout?: number;
  /** Normalized approval gate; when set the whole run is held before any job dispatches. */
  readonly approval?: LockApproval;
}

/**
 * Complete lock file structure.
 * Schema version 11 - designed for fast orchestrator event matching.
 * v2 adds per-workflow contentHash and compileSchemaVersion.
 * v3 adds 13 new trigger types (tag, comment, review, release, dispatch, etc.).
 * v4 adds 4 internal event routing trigger types (kici_event, workflow_complete,
 * job_complete, generic_webhook).
 * v5 adds schedule, lifecycle triggers, generic webhook auth, and job-level contexts.
 * v6 replaces job-level contexts with environment/env/concurrencyGroup.
 * v7 adds hook flags, step rules, gracePeriod, and workflow concurrency config.
 * v8 adds runsOn polymorphic type (string | string[] | selector) and excludeLabels.
 * v9 adds repos/notRepos repo pattern fields to git-event triggers for global workflow matching.
 * v10 removes notRepos/notPaths fields; negative patterns use ! prefix in repos/paths arrays.
 * v11 adds LockInlineValue type for pure function inline evaluation.
 * v12 adds workflow-level registries and installEnv for private npm registry auth.
 * v13 adds job-level and workflow-level timeout.
 */
export interface LockFile {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly source: LockSource;
  /** SHA-256 hash of the serialized lock file content (excluding this field). Changes only when workflows, triggers, jobs, or bundle hashes change. */
  readonly contentHash: string;
  /** SHA-256 hash of .kici/ lockfile (pnpm-lock.yaml or package-lock.json). Used for dependency cache keying. */
  readonly lockfileHash?: string;
  readonly workflows: readonly LockWorkflow[];
}

/** Type guard for static jobs */
export function isLockStaticJob(job: LockJobOrFactory): job is LockJob {
  return job._type === 'static';
}

/** Type guard for dynamic job generators */
export function isLockDynamicJobFn(job: LockJobOrFactory): job is LockDynamicJobFn {
  return job._type === 'dynamic';
}

/**
 * Simulated event payload structure for trigger matching.
 *
 * Known event types: push, pull_request, tag, comment, review, review_comment,
 * dispatch, release, create, delete, status, workflow_run, fork, star, watch,
 * kici_event, workflow_complete, job_complete, generic_webhook, schedule, lifecycle
 */
export interface SimulatedEvent {
  type: string;
  action?: string;
  payload: Record<string, unknown>;
  /** Branch being pushed to or PR target */
  targetBranch: string;
  /** PR source branch (only for PRs) */
  sourceBranch?: string;
  /** Changed files (for path filtering) */
  changedFiles?: string[];
  /** Which provider originated this event. Optional for backward compatibility with compiler/test CLI. */
  provider?: ProviderType;
  /** Whether this PR comes from a fork (head repo != base repo). Only set for PR events. */
  isForkPR?: boolean;
  /** Base branch ref for PR events (the branch being merged into). */
  baseBranch?: string;
  /** Sender username from the webhook payload (e.g. GitHub login). */
  senderUsername?: string;
  /**
   * Immutable IDP-side numeric id of the sender (e.g. GitHub's `sender.id`).
   * Mirrors Platform's `identity_links.provider_user_id`. The orchestrator
   * trust resolver prefers this over `senderUsername` because GitHub logins
   * are mutable and a recycled login can otherwise inherit trust granted
   * to the previous owner.
   */
  senderUserId?: string;
  /** Repository identifier where the event occurred (e.g., "owner/repo").
   *  Used by global workflow repo pattern matching. */
  sourceRepo?: string;
}
