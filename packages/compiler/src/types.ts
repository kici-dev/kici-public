/**
 * Lock file schema version 11.
 * Designed for orchestrator consumption with fast event matching.
 * v2 adds per-workflow contentHash and compileSchemaVersion fields.
 * v3 adds 13 new trigger types (tag, comment, review, release, dispatch, etc.).
 * v4 adds 4 internal/generic trigger types (kici_event, workflow_complete, job_complete, generic_webhook).
 * v5 adds schedule, lifecycle triggers, generic webhook auth, and job-level contexts.
 * v6 replaces job-level contexts with environment/env/concurrencyGroup.
 * v7 adds hook flags, step rules, gracePeriod, and workflow concurrency config.
 * v8 adds runsOn polymorphic type (string | string[] | selector) and excludeLabels.
 * v11 adds LockInlineValue type for pure function inline evaluation.
 * v15 adds per-job init config(s).
 * v17 widens per-job init to typed presets ('mise' / { mise }) and 'auto' detection.
 */

import { SCHEMA_VERSION as _SCHEMA_VERSION } from '@kici-dev/engine';
import type {
  ResourceRequest,
  ApproverClause,
  RunsOnAllPredicate,
  OnUnreachableMode,
  LabelMatcher,
} from '@kici-dev/engine';

/**
 * Normalized approval config carried in the lock file. Mirrors the engine
 * `LockApproval` type. Produced by the compiler from an SDK `requireApproval`.
 */
export interface LockApproval {
  readonly clauses: ApproverClause[];
  readonly reason?: string;
  readonly timeoutSeconds?: number;
}

/** Schema version - re-exported from engine as single source of truth */
export const SCHEMA_VERSION = _SCHEMA_VERSION;

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
  /** Declarative cache specs (normalized to an array). Restored before / saved after the step. */
  readonly cache?: readonly import('@kici-dev/sdk').CacheSpec[];
  /** Source location of the step() call in the original TypeScript file (for annotations). */
  readonly sourceLocation?: {
    readonly file: string;
    readonly line: number;
    readonly column: number;
  };
  /** Whether this step has conditional rules (evaluated agent-side). */
  readonly hasRules?: boolean;
  /** Step-level rules (same format as job rules). */
  readonly rules?: readonly LockRule[];
  /** Whether this step has an onCancel hook. */
  readonly hasOnCancel?: boolean;
  /** Whether this step has a cleanup hook. */
  readonly hasCleanup?: boolean;
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
 * Static job in lock file.
 * Contains all orchestrator-readable information for scheduling.
 *
 * Note: `runsOn` contains user-supplied labels only. The `kici:role:*` labels
 * (e.g., `kici:role:builder`, `kici:role:init-runner`) are injected by the orchestrator
 * for internal job types (build/init) and are not user-settable.
 */
/** Needs entry with per-edge failure policy (mirrors engine NeedsEntry). */
export interface LockNeedsEntry {
  readonly name: string;
  readonly ifFailed: 'skip' | 'run';
}

/** Needs group entry for dynamic group dependencies (mirrors engine NeedsGroupEntry). */
export interface LockNeedsGroupEntry {
  readonly group: string;
  readonly ifFailed: 'skip' | 'run';
}

export interface LockJob {
  readonly _type: 'static';
  readonly name: string;
  /** Single-agent targeting matchers. Absent when the job uses runsOnAll instead. */
  readonly runsOn?: readonly LabelMatcher[];
  readonly excludeLabels?: readonly LabelMatcher[];
  /** Host fan-out predicate (mutually exclusive with runsOn). */
  readonly runsOnAll?: RunsOnAllPredicate;
  /** Failure policy for unreachable durable hosts in a runsOnAll fan-out. */
  readonly onUnreachable?: OnUnreachableMode;
  /** Fan-out concurrency width (sliding window; 1 = serial). Applies to matrix and runsOnAll. */
  readonly maxParallel?: number;
  /** Halt the fan-out on first child failure, skipping the held remainder. Default false. */
  readonly failFast?: boolean;
  readonly needs: readonly (string | LockNeedsEntry | LockNeedsGroupEntry)[];
  /** Group names this job depends on (populated from dynamicGroup refs). */
  readonly dependsOnGroups?: readonly string[];
  readonly steps: readonly LockStep[];
  readonly matrix?: LockMatrix;
  readonly include?: readonly Record<string, string>[];
  readonly exclude?: readonly Record<string, string>[];
  readonly rules?: readonly LockRule[];
  readonly description?: string;
  /** When false, agent skips git clone (default: true). */
  readonly checkout?: boolean;
  /** Declarative cache specs (normalized to an array). Restored before steps / saved after the job. */
  readonly cache?: readonly import('@kici-dev/sdk').CacheSpec[];
  /** Docker image for job execution. All steps run inside the container. */
  readonly container?: string | { image: string; env?: Record<string, string> };
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
  /** Whether this job has an onCancel hook. */
  readonly hasOnCancel?: boolean;
  /** Whether this job has a cleanup hook. */
  readonly hasCleanup?: boolean;
  /** Whether this job has an onSuccess hook. */
  readonly hasOnSuccess?: boolean;
  /** Whether this job has an onFailure hook. */
  readonly hasOnFailure?: boolean;
  /** Whether this job has a beforeStep hook. */
  readonly hasBeforeStep?: boolean;
  /** Whether this job has an afterStep hook. */
  readonly hasAfterStep?: boolean;
  /** Seconds before SIGKILL after SIGTERM during cancellation. */
  readonly gracePeriod?: number;
  /** Total job wall-clock timeout in milliseconds (init + all steps + hooks). Agent reads this from jobConfig to arm a job-level deadline. */
  readonly timeout?: number;
  /**
   * Resource request and limit for this job.
   * Threaded from SDK `Job.resources` to the orchestrator scaler for cap accounting
   * (`requests`) and kernel-side enforcement (`limits`) on the spawned agent.
   */
  readonly resources?: ResourceRequest;
  /**
   * Per-job init config(s) run after clone, before steps. A generic config,
   * a typed preset (`'mise'` / `{ mise }`), an ordered array, `'auto'`
   * (detect from committed files), or `false` (opt-out). Threaded verbatim from
   * the SDK `Job.init` -- the agent reads it from the loaded module, the lock
   * copy is for orchestrator/dashboard visibility.
   */
  readonly init?: import('@kici-dev/sdk').InitConfig;
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
  readonly needs?: readonly (string | LockNeedsEntry | LockNeedsGroupEntry)[];
  /** True when this dynamic entry was authored as dynamicJob(group, { needs, generate }). */
  readonly resultAware?: boolean;
}

/** Job or dynamic job generator */
export type LockJobOrFactory = LockJob | LockDynamicJobFn;

/**
 * Private npm registry declaration in the lock file.
 * Carries URL/scope/secret-reference but NOT the resolved token — the orchestrator
 * resolves the token at dispatch via the per-environment secretResolver path.
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
  /** Secret contexts declared by the workflow. Orchestrator validates access before dispatch. */
  readonly contexts?: readonly string[];
  /**
   * Private npm registries the agent should authenticate against before `npm install`.
   * Resolved-token bytes never appear in the lock file.
   */
  readonly registries?: readonly LockRegistry[];
  /**
   * Extra qualified secret refs (`<environment>:<secret-name>`) to project as env vars
   * on the install subprocess for use with a customer-committed `.kici/.npmrc`.
   */
  readonly installEnv?: readonly string[];
  /** Whether this workflow has an onCancel hook. */
  readonly hasOnCancel?: boolean;
  /** Whether this workflow has a cleanup hook. */
  readonly hasCleanup?: boolean;
  /** Whether this workflow has an onSuccess hook. */
  readonly hasOnSuccess?: boolean;
  /** Whether this workflow has an onFailure hook. */
  readonly hasOnFailure?: boolean;
  /** Concurrency configuration for this workflow. */
  readonly concurrency?: {
    readonly hasGroup: boolean;
    readonly cancelInProgress?: boolean;
    readonly max?: number;
  };
  /** Whole-run wall-clock timeout in milliseconds. Orchestrator reads this at run creation to set the run deadline. */
  readonly timeout?: number;
  /** Normalized approval gate; when set the whole run is held before any job dispatches. */
  readonly approval?: LockApproval;
}

/**
 * Complete lock file structure.
 * Schema version 11 - designed for fast orchestrator event matching.
 * v2 adds per-workflow contentHash and compileSchemaVersion.
 * v3 adds 13 new trigger types (tag, comment, review, release, dispatch, etc.).
 * v4 adds 4 internal/generic trigger types (kici_event, workflow_complete, job_complete, generic_webhook).
 * v5 adds schedule, lifecycle triggers, generic webhook auth, and job-level contexts.
 * v6 replaces job-level contexts with environment/env/concurrencyGroup.
 * v7 adds hook flags, step rules, gracePeriod, and workflow concurrency config.
 * v8 adds runsOn polymorphic type (string | string[] | selector) and excludeLabels.
 * v11 adds LockInlineValue type for pure function inline evaluation.
 * v13 adds job-level and workflow-level timeout.
 */
export interface LockFile {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly source: LockSource;
  /** SHA-256 hash of the serialized lock file content (excluding this field). Changes only when workflows, triggers, jobs, or bundle hashes change. */
  readonly contentHash: string;
  /**
   * SHA-256 hash of the repo's lockfile, used as the dependency cache key. The
   * lockfile is the one the detected package manager produces — `.kici/`'s
   * `package-lock.json` for npm, or the repo-root `pnpm-lock.yaml` /
   * `yarn.lock` for a pnpm/yarn workspace. The hash input is prefixed with the
   * manager name so a manager change is a guaranteed cache miss.
   */
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

/** Source information for a workflow, tracked during discovery */
export interface WorkflowSourceInfo {
  /** Absolute path to source file */
  readonly file: string;
  /** Export name (or 'default' for default exports) */
  readonly exportName: string;
  /** Index if from default array export */
  readonly arrayIndex?: number;
}

/** Workflow with source tracking, used during discovery */
export interface WorkflowWithSource {
  readonly workflow: import('@kici-dev/sdk').Workflow;
  readonly source: WorkflowSourceInfo;
  /** Raw rolldown output text for content hashing (without source maps). Optional for test-runner path. */
  readonly bundleSource?: string;
}
