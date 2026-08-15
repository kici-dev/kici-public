/**
 * Lock file types for the trigger matching engine.
 * Single source of truth -- replaces local copies in @kici-dev/compiler and @kici-dev/orchestrator.
 *
 * Bump-history convention: every entry is annotated `additive` (older readers
 * tolerate the new lock because unknown fields are ignored) or `BREAKING` (an
 * older reader would mis-parse the lock). Every `BREAKING` bump moves
 * `BREAKING_FLOOR` (below) to that version in the SAME commit.
 *
 * Schema version 4 (additive): adds 4 internal event routing trigger types (kici_event, workflow_complete,
 * job_complete, generic_webhook).
 * Schema version 6 (BREAKING): replaces job-level contexts with environment/env/concurrencyGroup.
 * Schema version 8 (additive): adds runsOn polymorphic type (string | string[] | selector) and excludeLabels.
 * Schema version 9 (additive): adds repos/notRepos repo pattern fields to git-event triggers for global workflow matching.
 * Schema version 10 (BREAKING): removes notRepos/notPaths fields, negative patterns use ! prefix in repos/paths arrays.
 * Schema version 11 (additive): adds LockInlineValue type for pure function inline evaluation.
 * Schema version 14 (additive): adds declarative cache specs to LockJob and LockStep.
 * Schema version 15 (additive): adds per-job init config(s) to LockJob.
 * Schema version 16 (additive): adds normalized approval config to LockWorkflow/LockJob/LockStep.
 * Schema version 17 (additive): widens LockJob.init to typed presets ('mise' / { mise }) and 'auto' detection.
 * Schema version 18 (additive): adds LockJob.runsOnAll host fan-out predicate + onUnreachable policy.
 * Schema version 19 (additive): adds LockJob.maxParallel/failFast fan-out concurrency (rolling waves).
 * Schema version 20 (BREAKING): runsOn/runsOnAll/excludeLabels carry LabelMatcher (exact|regex) for glob+regex selectors.
 * Schema version 23 (additive): adds LockDispatchTrigger.inputs (typed dispatch inputs descriptors).
 * Schema version 24 (additive): adds LockJob.runsOnPick (deterministic single-host selection).
 * Schema version 25 (additive): adds LockStep.retry (step retry policy data subset; retryIf is execution-only).
 * Schema version 26 (additive): adds LockJob.includeUninitialized (runsOnAll fans out to declared-but-un-agented hosts, bringing up a temporary init-runner per fresh box).
 * Schema version 27 (additive): adds LockScheduleTrigger.inputs (defaults-only schedule dispatch inputs).
 * Schema version 30 (BREAKING): renames job-level `environments` to `contexts`.
 * Schema version 31 (additive): adds the workflows_failed_batch lock trigger.
 * Schema version 32 (additive): adds LockJob.sandbox (per-job escape-hatch request).
 * Schema version 33 (additive): adds `requires` (declarative static content filter) to the push/pr/tag git-event triggers.
 * Schema version 34 (additive): adds LockWorkflow.hasFilter (workflow-level pre-dispatch filter predicate).
 * Schema version 35 (additive): adds `commitMessage` (LockTextMatch) to the push/pr/tag
 *   git-event triggers, and contains/notContains/notMatches to LockContentRequirement.
 */

import { z } from 'zod';
import type { ProviderType } from '../provider/types.js';
import type { ApproverClause } from '../approval/types.js';
import type { InputsDescriptorMap } from '../inputs/descriptor.js';
import { LabelMatcher } from '../labels-match.js';
import { ExecutionJobStatus, TERMINAL_JOB_STATES } from '../protocol/messages/execution-status.js';
import { isFailureStatus } from '../status/presentation.js';

/**
 * Schema version the compiler emits into every lock file. Incremented on ANY
 * schema change (additive or breaking); the bump-history comment above records
 * which. See `BREAKING_FLOOR` for the compatibility-window semantics.
 */
export const SCHEMA_VERSION = 35 as const;

/**
 * Oldest lock schema version this codebase can still read correctly — the lower
 * bound of the acceptance window.
 *
 * A lock at `schemaVersion >= BREAKING_FLOOR` parses correctly here even if it
 * is newer than `SCHEMA_VERSION` (additive bumps add fields this reader ignores).
 * A lock below the floor was produced by an SDK whose breaking change this
 * reader predates and must be rejected (it would mis-parse silently otherwise).
 *
 * Bump rule: move this to the current `SCHEMA_VERSION` ONLY in the commit that
 * lands a `BREAKING` schema change (see the bump-history convention above). It
 * currently sits at 30 because v30 (`environments`→`contexts`) was the most
 * recent breaking bump; v31 through v35 were additive, so a v30 lock still
 * reads correctly.
 */
export const BREAKING_FLOOR = 30 as const;

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
 * A declarative query over one piece of text: literal substrings and/or a
 * regex, in either direction. Pure DATA the orchestrator interprets — never
 * author code — so it is safe to evaluate inside the orchestrator under the
 * execution-purity model.
 *
 * Every entry in a list is a CONJUNCT: `contains: [a, b]` means the text
 * contains `a` AND contains `b`. OR is expressed by declaring two triggers,
 * since a workflow's trigger list is already "first match wins".
 *
 * This is the SDK-facing shape a workflow author writes; the compiler
 * normalizes it to {@link LockTextMatch}.
 */
export interface TextMatch {
  /** Literal substring(s). Every entry must be present. */
  readonly contains?: string | readonly string[];
  /** Literal substring(s). No entry may be present. */
  readonly notContains?: string | readonly string[];
  /** Regex(es), as a RegExp or a `/pattern/flags` string. Every one must match. */
  readonly matches?: string | RegExp | readonly (string | RegExp)[];
  /** Regex(es). None may match. */
  readonly notMatches?: string | RegExp | readonly (string | RegExp)[];
  /**
   * Case-insensitive comparison for `contains`/`notContains` ONLY. Default false.
   * It deliberately does not touch the regex keys: a regex already carries its
   * own flags, and injecting `i` into a pattern whose author omitted it would
   * silently change its meaning.
   */
  readonly ignoreCase?: boolean;
}

/**
 * Lock-file form of {@link TextMatch}. The compiler normalizes every key to a
 * flat array, and every regex to a `/pattern/flags` string, so the orchestrator
 * matcher has exactly one shape to interpret.
 */
export interface LockTextMatch {
  readonly contains?: readonly string[];
  readonly notContains?: readonly string[];
  /** Always in `/pattern/flags` form. */
  readonly matches?: readonly string[];
  /** Always in `/pattern/flags` form. */
  readonly notMatches?: readonly string[];
  readonly ignoreCase?: boolean;
}

/**
 * How a file's bytes are parsed before a content query runs.
 * `auto` picks by extension: `.json` → json, `.yaml`/`.yml` → yaml, else text.
 */
export type ContentFormat = 'json' | 'yaml' | 'text' | 'auto';

/**
 * Declarative static content filter: a query over the bytes of one source file
 * at the event's ref. Pure DATA the orchestrator's own matcher interprets — never
 * author code — so it is safe to evaluate in the orchestrator (Part B of the
 * execution-purity model). Query keys
 * (`exists`/`match`/`not`/`contains`/`notContains`/`matches`/`notMatches`) are
 * AND-ed within an entry; `absent` is mutually exclusive with them and passes
 * only when the file is missing.
 *
 * This is the SDK-facing shape a workflow author writes, which accepts a scalar
 * or `RegExp` where the lock form ({@link LockContentRequirement}) carries a flat
 * array of `/pattern/flags` strings — the compiler normalizes one to the other.
 */
export interface ContentRequirement {
  /** Repo-relative path of the file to query. */
  readonly file: string;
  /** Parse format; defaults to `auto` when unset. */
  readonly format?: ContentFormat;
  /** JSONPath expressions that must each resolve to ≥1 node (json/yaml only). */
  readonly exists?: readonly string[];
  /** JSONPath → expected-value map; every expression must match (json/yaml only). */
  readonly match?: Record<string, unknown>;
  /** JSONPath → value map; passes only when NONE match (json/yaml only). */
  readonly not?: Record<string, unknown>;
  /** Literal substring(s) that must ALL be present in the raw file text. */
  readonly contains?: string | readonly string[];
  /** Literal substring(s) of which NONE may be present in the raw file text. */
  readonly notContains?: string | readonly string[];
  /** Regex(es) that must ALL match the raw file text (RegExp or `/pattern/flags`). */
  readonly matches?: string | RegExp | readonly (string | RegExp)[];
  /** Regex(es) of which NONE may match the raw file text. */
  readonly notMatches?: string | RegExp | readonly (string | RegExp)[];
  /** Case-insensitive `contains`/`notContains`. Default false. */
  readonly ignoreCase?: boolean;
  /** When true, the entry passes only if the file is absent. Excludes all query keys. */
  readonly absent?: boolean;
}

/**
 * Lock-file form of {@link ContentRequirement}. The compiler normalizes each
 * raw-text key to the flat {@link LockTextMatch} shape, so the orchestrator
 * matcher has one shape to interpret.
 */
export interface LockContentRequirement {
  readonly file: string;
  readonly format?: ContentFormat;
  readonly exists?: readonly string[];
  readonly match?: Record<string, unknown>;
  readonly not?: Record<string, unknown>;
  readonly contains?: readonly string[];
  readonly notContains?: readonly string[];
  readonly matches?: readonly string[];
  readonly notMatches?: readonly string[];
  readonly ignoreCase?: boolean;
  readonly absent?: boolean;
}

/**
 * Resolve a content requirement's parse format to a concrete value. An explicit
 * non-`auto` format is returned as-is; `auto` (or unset) is resolved by the file
 * extension: `.json` → json, `.yaml`/`.yml` → yaml, everything else text.
 *
 * Yaml-free (pure string logic) so it lives in the browser-safe barrel and is
 * the single source of truth for both the compiler's compile-time serializer and
 * the orchestrator's eval-time matcher — the two can never disagree about how a
 * file's format is picked.
 */
export function resolveContentFormat(
  file: string,
  format: ContentFormat | undefined,
): 'json' | 'yaml' | 'text' {
  if (format && format !== 'auto') return format;
  const lower = file.toLowerCase();
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  return 'text';
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
  /** Declarative static content filter over source files at the event ref (AND-ed). */
  readonly requires?: readonly LockContentRequirement[];
  /** Declarative static filter over the event's commit message / PR title+body. */
  readonly commitMessage?: LockTextMatch;
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
  /** Declarative static content filter over source files at the event ref (AND-ed). */
  readonly requires?: readonly LockContentRequirement[];
  /** Declarative static filter over the event's commit message / PR title+body. */
  readonly commitMessage?: LockTextMatch;
}

/**
 * Tag trigger in lock file.
 * Matches tag push events. Reuses LockBranchPattern for tag name patterns.
 */
export interface LockTagTrigger {
  readonly _type: 'tag';
  readonly patterns: readonly LockBranchPattern[];
  readonly repos?: readonly LockBranchPattern[];
  /** Declarative static content filter over source files at the event ref (AND-ed). */
  readonly requires?: readonly LockContentRequirement[];
  /** Declarative static filter over the event's commit message / PR title+body. */
  readonly commitMessage?: LockTextMatch;
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
  /** Typed dispatch-input descriptors (from `dispatch({ inputs })`). */
  readonly inputs?: InputsDescriptorMap;
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
 * Workflows-failed-batch trigger in lock file.
 *
 * Accumulates failed workflow completions over `accumulateFor` ms and fires the
 * subscribing workflow once per window with the batched run list. The matcher
 * treats a failed `workflow_complete` event as an accumulation input and a
 * synthetic `workflows_failed_batch` event as the dispatch trigger.
 */
export interface LockWorkflowsFailedBatchTrigger {
  readonly _type: 'workflows_failed_batch';
  /** Accumulation window in milliseconds; the window opens on the first failure. */
  readonly accumulateFor: number;
  readonly name?: string;
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
  /** Typed schedule-input descriptors (from `schedule({ inputs })`); defaults-only. */
  readonly inputs?: InputsDescriptorMap;
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
  | LockWorkflowsFailedBatchTrigger
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
  /** Discriminator for the step union; absent/`'sequential'` is an ordinary step. */
  readonly kind?: 'sequential';
  readonly name: string;
  readonly hasOutputs: boolean;
  /** When true, job proceeds even if this step fails. */
  readonly continueOnError?: boolean;
  /** Step-level timeout in milliseconds. */
  readonly timeout?: number;
  /** Retry policy data (retryIf is execution-only and never serialized). */
  readonly retry?: {
    readonly maxAttempts: number;
    readonly delayMs: number;
    readonly backoff: 'fixed' | 'exponential';
    readonly maxDelayMs: number;
  };
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
 * A concurrent group of sequential steps in the lock file. Children run
 * concurrently behind a join barrier; the group wrapper itself consumes no
 * flat step index (its children carry the indices). No nesting is allowed.
 */
export interface LockParallelStep {
  readonly kind: 'parallel';
  readonly name: string;
  /** Cancel in-flight siblings when the first child fails (default true). */
  readonly failFast: boolean;
  /** Maximum children running at once; queued children report `pending`. */
  readonly maxParallel?: number;
  readonly children: readonly LockStep[];
}

/** A lock-file entry in a job's `steps` array: an ordinary step or a parallel group. */
export type LockStepEntry = LockStep | LockParallelStep;

/** Type guard distinguishing a parallel group from an ordinary lock step. */
export function isLockParallelStep(entry: LockStepEntry): entry is LockParallelStep {
  return (entry as LockParallelStep).kind === 'parallel';
}

/**
 * Serialized inline expression for a dynamic env/context/concurrencyGroup
 * field, shaped as `{ _type: 'inline', expression: '(event) => ...' }`
 * alongside the existing 'static' and 'dynamic' discriminants.
 *
 * @deprecated Schema v11 inline expressions are no longer evaluated in the
 * orchestrator. Dynamic env/context/concurrencyGroup fields are resolved on the
 * eval agent's init-runner. The compiler no longer emits this type; readers keep
 * recognizing it only to defer an old lock's field to the init round. Removed at
 * the next major (v1.0.0).
 */
export interface LockInlineValue {
  readonly _type: 'inline';
  readonly expression: string;
}

/**
 * Type guard for inline expression values.
 *
 * @deprecated See {@link LockInlineValue}. Retained only so a reader can
 * recognize an old lock's inline field and defer it to the eval agent's
 * init-runner. Removed at the next major (v1.0.0).
 */
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

const WHEN_TO_RUN_ON: Readonly<Record<NeedsWhen, readonly ExecutionJobStatus[]>> = {
  'on-success': [ExecutionJobStatus.enum.success],
  always: [...TERMINAL_JOB_STATES] as ExecutionJobStatus[],
  'on-skip': [ExecutionJobStatus.enum.success, ExecutionJobStatus.enum.skipped],
  // Derived, not listed: the terminal statuses that mean the workflow did not
  // do what it declared. Reading the same classification the run roll-up reads
  // is what stops the two from disagreeing — a drift-dropped job already makes
  // its run fail, so a downstream error handler must run for it too.
  // `cancelled` stays out (deliberately stopped, its own outcome) and so does
  // `skipped` (never ran).
  'on-failure': ([...TERMINAL_JOB_STATES] as ExecutionJobStatus[]).filter(isFailureStatus),
};

/**
 * Resolve the author-facing `when` (keyword sugar | raw status-set | unset) to
 * the normalized status-set. An unset `when` defaults to success-only — the
 * downstream runs only when the upstream succeeded.
 *
 * Always a fresh array. The keyword arm used to hand back the shared
 * `WHEN_TO_RUN_ON` entry itself, so every lock-file edge compiled from the same
 * keyword aliased one array and any caller that sorted or mutated its result
 * silently reordered the keyword's expansion for every other edge.
 */
export function resolveWhenToRunOn(
  when: NeedsWhen | ExecutionJobStatus[] | undefined,
): ExecutionJobStatus[] {
  if (when === undefined) return [ExecutionJobStatus.enum.success];
  if (Array.isArray(when)) return [...when];
  return [...WHEN_TO_RUN_ON[when]];
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

/**
 * Single-agent selection policy when multiple agents match a `runsOn` selector.
 *
 * - `deterministic` (default): sort matching candidates by `agentId` and pick the
 *   lowest, so a run-once-on-one-host job is reproducible across re-runs.
 * - `any`: pick any available agent (load spread).
 */
export const RunsOnPick = z.enum(['deterministic', 'any']);
export type RunsOnPick = z.infer<typeof RunsOnPick>;

/** Container network posture: 'default' (bridge), 'none' (loopback-only), 'host' (host netns; gated). */
export const SANDBOX_NETWORK_MODES = ['default', 'none', 'host'] as const;
export type SandboxNetworkMode = (typeof SANDBOX_NETWORK_MODES)[number];

/**
 * The dispatch-resolved, allow-listed per-job sandbox escape hatch. Produced
 * orchestrator-side at dispatch (the agent never resolves it) and applied
 * additively over the hardened container baseline by the agent. The lock carries
 * the workflow-declared request (`LockJob.sandbox`); this is the resolved grant
 * the orchestrator authorized against the operator's `org_settings` allow-list.
 */
export interface ResolvedSandboxGrant {
  /** Extra Linux capabilities added back over CapDrop:['ALL'] (bare form, e.g. 'NET_ADMIN'). */
  capabilities?: string[];
  /** Network override; when set it wins over the config network mode. */
  network?: SandboxNetworkMode;
  /** Force a read-only rootfs (operator-config path only in Phase 2). */
  readonlyRootfs?: boolean;
  /** Run the container as this user (operator-config path only in Phase 2). */
  user?: string;
}

export interface LockJob {
  readonly _type: 'static';
  readonly name: string;
  /** Single-agent targeting matchers. Absent when the job uses `runsOnAll` instead. */
  readonly runsOn?: readonly LabelMatcher[];
  readonly excludeLabels?: readonly LabelMatcher[];
  /**
   * Single-agent selection policy when more than one agent matches `runsOn`.
   * `deterministic` (default) sorts candidates by `agentId` and picks the lowest;
   * `any` picks any available agent. Absent on a `runsOnAll` fan-out job.
   */
  readonly runsOnPick?: RunsOnPick;
  /**
   * Host fan-out predicate (mutually exclusive with `runsOn`). When set, the job
   * fans out to every roster host matching the predicate, one pinned child per host.
   */
  readonly runsOnAll?: RunsOnAllPredicate;
  /** Failure policy for unreachable durable hosts in a `runsOnAll` fan-out. */
  readonly onUnreachable?: OnUnreachableMode;
  /**
   * Widen a `runsOnAll` fan-out to declared-but-un-agented hosts. When true,
   * every roster host matching the predicate is a fan-out target even with no
   * live agent: a fresh host gets a temporary init-runner brought up over SSH
   * and its pinned steps run there; a live host runs on its own agent. Default
   * absent ⇒ only live hosts (today's behavior governed by `onUnreachable`).
   */
  readonly includeUninitialized?: boolean;
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
  readonly steps: readonly LockStepEntry[];
  readonly matrix?: LockMatrix;
  readonly include?: readonly Record<string, string>[];
  readonly exclude?: readonly Record<string, string>[];
  readonly rules?: readonly LockRule[];
  readonly description?: string;
  /**
   * Bound contexts in merge order. Each entry is a static name; `dynamic` is set
   * when it is a function resolved on the eval agent's init-runner. Later entries
   * override earlier ones on name collisions. The `LockInlineValue` shape is a
   * deprecated form still accepted from old locks (see {@link LockInlineValue}).
   */
  readonly contexts?: ReadonlyArray<{ value: string | LockInlineValue; dynamic: boolean }>;
  /**
   * Static environment variables. A deprecated `LockInlineValue` shape is still
   * accepted from old locks (see {@link LockInlineValue}).
   */
  readonly env?: Record<string, string> | LockInlineValue;
  /** When true, env is dynamic (function) -- resolved on the eval agent's init-runner. */
  readonly dynamicEnv?: boolean;
  /**
   * Concurrency group name (static string). A deprecated `LockInlineValue` shape
   * is still accepted from old locks (see {@link LockInlineValue}).
   */
  readonly concurrencyGroup?: string | LockInlineValue;
  /** When true, concurrencyGroup is dynamic (function) -- resolved on the eval agent's init-runner. */
  readonly dynamicConcurrencyGroup?: boolean;
  /** Total job wall-clock timeout in milliseconds (init + all steps + hooks). Threaded to the agent via jobConfig. */
  readonly timeout?: number;
  /**
   * Resource request and limit for this job.
   * Threaded from SDK `Job.resources` to the orchestrator scaler for cap accounting
   * (`requests`) and kernel-side enforcement (`limits`) on the spawned agent.
   */
  readonly resources?: import('../scaler/resource-types.js').ResourceRequest;
  /**
   * Container image selecting the container execution backend on the agent. A
   * bare image string or an object with `image` + optional `env`. When set, the
   * agent's `determineExecutionMode` routes the job to the container sandbox
   * (top priority), so the orchestrator threads it through dispatch as
   * `jobConfig.container`. (Shape mirrors the SDK `string | ContainerConfig`;
   * the engine cannot import the SDK, so it is inlined here.)
   */
  readonly container?: string | { readonly image: string; readonly env?: Record<string, string> };
  /**
   * Workflow-declared per-job sandbox escape-hatch request (container jobs
   * only). The orchestrator resolves it at dispatch against the operator's
   * `org_settings` allow-list into a `ResolvedSandboxGrant` (a non-allow-listed
   * request fails the run); the agent never reads this field. Additive — an
   * older orchestrator that does not understand it ignores it.
   */
  readonly sandbox?: {
    readonly capabilities?: string[];
    readonly network?: SandboxNetworkMode;
  };
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
 * the orchestrator resolves the token at dispatch time via the per-context
 * secretResolver.resolveForJob path.
 */
export interface LockRegistry {
  readonly url: string;
  readonly scope?: string;
  /** Qualified secret reference: `<context>:<secret-name>`. */
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
   * Extra qualified secret refs (`<context>:<secret-name>`) to project as
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
  /**
   * True when the workflow declares a `filter` predicate. A bare flag, not a
   * source reference: `LockWorkflow.source` already identifies the module and
   * export, so the eval agent loads it and reads `.filter` off the workflow
   * object. Mirrors the `dynamicEnv` / `dynamicConcurrencyGroup` convention.
   */
  readonly hasFilter?: boolean;
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
 * v11 adds the LockInlineValue type (deprecated; inline dynamic fields are resolved on the eval agent).
 * v12 adds workflow-level registries and installEnv for private npm registry auth.
 * v13 adds job-level and workflow-level timeout.
 */
export interface LockFile {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  /**
   * The newest breaking schema version at emit time (the compiler stamps
   * `BREAKING_FLOOR`). A reader whose own `SCHEMA_VERSION` is below this value
   * predates a breaking change the lock relies on and must reject it. Absent on
   * pre-window locks, in which case the reader falls back to exact-match
   * strictness (see `assertLockFileSchemaCompatible`).
   */
  readonly minReaderVersion?: number;
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
 * Availability of the changed-files list for path-filter evaluation.
 *
 * Distinguishes three states that a bare `string[]` collapses into one:
 * - `skipped` — no trigger has path patterns, so the fetch never ran. Path
 *   filters are not evaluated (today's no-fetch fast path).
 * - `fetched` — the fetch succeeded and the list is authoritative; an empty
 *   list genuinely means "no files changed" and does NOT match a path filter.
 * - `unavailable` — the diff could not be determined (a provider capability
 *   gap such as universal-git PR events, or upstream degradation). Path
 *   filters match conservatively so a real change is never silently dropped.
 */
export const changedFilesStatusSchema = z.enum(['fetched', 'unavailable', 'skipped']);
export type ChangedFilesStatus = z.infer<typeof changedFilesStatusSchema>;

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
  /** Pull-request number for PR-family events (pull_request / review / review_comment); undefined otherwise. */
  prNumber?: number;
  /** Changed files (for path filtering) */
  changedFiles?: string[];
  /**
   * Availability of {@link changedFiles} for path-filter evaluation. When
   * `unavailable`, path filters match conservatively instead of inferring a
   * no-match from an empty list. Optional for backward compatibility with the
   * compiler/test CLI, which never fetches a diff (treated as legacy `fetched`
   * exact-match semantics).
   */
  changedFilesStatus?: ChangedFilesStatus;
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
  /**
   * Text a `commitMessage` trigger filter is tested against: the full head-commit
   * message for push/tag, or PR title + body for pull-request events. Absent when
   * the provider payload carries none — which a `commitMessage` filter treats as
   * INDETERMINATE (fail-visible), never as an empty string.
   */
  commitMessage?: string;
  /** Repository identifier where the event occurred (e.g., "owner/repo").
   *  Used by global workflow repo pattern matching. */
  sourceRepo?: string;
}
