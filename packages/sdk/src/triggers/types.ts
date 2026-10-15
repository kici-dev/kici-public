/** Trigger configuration types; branch and path filters accept glob or regex patterns. */

import type { z } from 'zod';
import type { ContentRequirement, TextMatch } from '@kici-dev/engine';
import { normalizeRegexFlags } from '@kici-dev/engine';

export type { ContentRequirement, ContentFormat, TextMatch } from '@kici-dev/engine';

/**
 * A declared map of typed workflow-dispatch inputs: `{ name: ZodSchema }`.
 * Each schema must fall within the closed dispatch-input subset (extracted by
 * the compiler) — z.string/number/boolean/enum/literal plus
 * .optional/.nullable/.default/.min/.max/.regex/.int.
 */
export type DispatchInputsMap = Record<string, z.ZodType>;

/** Branch pattern: glob (micromatch syntax) or regex (standard JS regex). */
export type BranchPattern =
  | { readonly type: 'glob'; readonly pattern: string }
  | { readonly type: 'regex'; readonly pattern: string; readonly flags?: string };

/** GitHub PR event types. */
export type PrEvent =
  | 'opened'
  | 'synchronize'
  | 'reopened'
  | 'closed'
  | 'assigned'
  | 'unassigned'
  | 'labeled'
  | 'unlabeled'
  | 'edited'
  | 'converted_to_draft'
  | 'ready_for_review'
  | 'locked'
  | 'unlocked'
  | 'review_requested'
  | 'review_request_removed'
  | 'auto_merge_enabled'
  | 'auto_merge_disabled';

/** Default PR events when `pr()` is called without `events`. */
export const DEFAULT_PR_EVENTS: readonly PrEvent[] = [
  'opened',
  'synchronize',
  'reopened',
  'closed',
] as const;

export type PushEvent = 'push';

export interface PrTriggerConfig {
  readonly _tag: 'PrTrigger';
  readonly events: readonly PrEvent[];
  readonly targetBranches: readonly BranchPattern[];
  readonly sourceBranches: readonly BranchPattern[];
  readonly paths: readonly string[];
  readonly repos: readonly BranchPattern[];
  /** Declarative static content filter over source files at the event ref (AND-ed). */
  readonly requires?: readonly ContentRequirement[];
  /** Declarative static filter over the event's commit message / PR title+body. */
  readonly commitMessage?: TextMatch;
  readonly description?: string;
}

export interface PushTriggerConfig {
  readonly _tag: 'PushTrigger';
  readonly branches: readonly BranchPattern[];
  readonly tags: readonly BranchPattern[];
  readonly paths: readonly string[];
  readonly repos: readonly BranchPattern[];
  /** Declarative static content filter over source files at the event ref (AND-ed). */
  readonly requires?: readonly ContentRequirement[];
  /** Declarative static filter over the event's commit message / PR title+body. */
  readonly commitMessage?: TextMatch;
  readonly description?: string;
}

// --- Tag trigger ---

export interface TagTriggerConfig {
  readonly _tag: 'TagTrigger';
  readonly patterns: readonly BranchPattern[];
  readonly repos: readonly BranchPattern[];
  /** Declarative static content filter over source files at the event ref (AND-ed). */
  readonly requires?: readonly ContentRequirement[];
  /** Declarative static filter over the event's commit message / PR title+body. */
  readonly commitMessage?: TextMatch;
  readonly description?: string;
}

/** Input for `tag()`. */
export interface TagConfigInput {
  readonly patterns?: string | RegExp | (string | RegExp)[];
  readonly repos?: string | RegExp | (string | RegExp)[];
  /** Declarative static content filter over source files at the event ref (AND-ed). */
  readonly requires?: readonly ContentRequirement[];
  /** Declarative static filter over the event's commit message / PR title+body. */
  readonly commitMessage?: TextMatch;
  readonly description?: string;
}

// --- Comment trigger ---

export type CommentAction = 'created' | 'edited' | 'deleted';

export type CommentSource = 'issue' | 'pr';

/** Serialized comment-trigger body match pattern. */
export type BodyMatchPattern =
  | { readonly type: 'glob'; readonly pattern: string }
  | { readonly type: 'regex'; readonly pattern: string; readonly flags?: string };

/** Comment trigger config (issue_comment / PR review comment). */
export interface CommentTriggerConfig {
  readonly _tag: 'CommentTrigger';
  readonly actions: readonly CommentAction[];
  readonly source?: CommentSource;
  readonly bodyMatch?: BodyMatchPattern;
  readonly repos: readonly BranchPattern[];
  readonly description?: string;
}

/** Input for `comment()`. */
export interface CommentConfigInput {
  readonly actions?: CommentAction[];
  readonly source?: CommentSource;
  readonly bodyMatch?: string | RegExp;
  readonly repos?: string | RegExp | (string | RegExp)[];
  readonly description?: string;
}

// --- Review trigger ---

export type ReviewAction = 'submitted' | 'edited' | 'dismissed';
export type ReviewState = 'approved' | 'changes_requested' | 'commented' | 'dismissed';

export interface ReviewTriggerConfig {
  readonly _tag: 'ReviewTrigger';
  readonly actions: readonly ReviewAction[];
  readonly states: readonly ReviewState[];
  readonly repos: readonly BranchPattern[];

  readonly description?: string;
}

/** Input for `review()`. */
export interface ReviewConfigInput {
  readonly actions?: ReviewAction[];
  readonly states?: ReviewState[];
  readonly repos?: string | RegExp | (string | RegExp)[];

  readonly description?: string;
}

// --- Review comment trigger ---

export type ReviewCommentAction = 'created' | 'edited' | 'deleted';

export interface ReviewCommentTriggerConfig {
  readonly _tag: 'ReviewCommentTrigger';
  readonly actions: readonly ReviewCommentAction[];
  readonly repos: readonly BranchPattern[];

  readonly description?: string;
}

/** Input for `reviewComment()`. */
export interface ReviewCommentConfigInput {
  readonly actions?: ReviewCommentAction[];
  readonly repos?: string | RegExp | (string | RegExp)[];

  readonly description?: string;
}

// --- Release trigger ---

export type ReleaseAction =
  'published' | 'unpublished' | 'created' | 'edited' | 'deleted' | 'prereleased' | 'released';

export interface ReleaseTriggerConfig {
  readonly _tag: 'ReleaseTrigger';
  readonly actions: readonly ReleaseAction[];
  readonly repos: readonly BranchPattern[];

  readonly description?: string;
}

/** Input for `release()`. */
export interface ReleaseConfigInput {
  readonly actions?: ReleaseAction[];
  readonly repos?: string | RegExp | (string | RegExp)[];

  readonly description?: string;
}

// --- Dispatch trigger ---

/** repository_dispatch trigger config. */
export interface DispatchTriggerConfig {
  readonly _tag: 'DispatchTrigger';
  readonly types: readonly string[];
  readonly repos: readonly BranchPattern[];

  readonly description?: string;
  /** Declared, typed workflow-dispatch inputs (frozen `{ name: ZodSchema }`). */
  readonly inputs?: DispatchInputsMap;
}

/** Input for `dispatch()`. */
export interface DispatchConfigInput {
  readonly types?: string[];
  readonly repos?: string | RegExp | (string | RegExp)[];

  readonly description?: string;
  /**
   * Typed workflow-dispatch inputs. Accepts a bare `{ name: ZodSchema }` map or
   * a `defineDispatchInputs(...)` branded handle (which also exposes a typed
   * `.from(ctx)` accessor). The compiler validates each schema against the
   * closed dispatch-input subset.
   */
  readonly inputs?:
    DispatchInputsMap | { readonly __kiciDispatchInputs: true; readonly map: DispatchInputsMap };
}

// --- Create trigger ---

export type RefType = 'branch' | 'tag';

/** Create-ref trigger config. */
export interface CreateTriggerConfig {
  readonly _tag: 'CreateTrigger';
  readonly refTypes: readonly RefType[];
  readonly patterns: readonly BranchPattern[];
  readonly repos: readonly BranchPattern[];

  readonly description?: string;
}

/** Input for `create()`. */
export interface CreateConfigInput {
  readonly refTypes?: RefType[];
  readonly patterns?: string | RegExp | (string | RegExp)[];
  readonly repos?: string | RegExp | (string | RegExp)[];

  readonly description?: string;
}

// --- Delete trigger ---

/** Delete-ref trigger config. */
export interface DeleteTriggerConfig {
  readonly _tag: 'DeleteTrigger';
  readonly refTypes: readonly RefType[];
  readonly patterns: readonly BranchPattern[];
  readonly repos: readonly BranchPattern[];

  readonly description?: string;
}

/** Input for `delete()`. */
export interface DeleteConfigInput {
  readonly refTypes?: RefType[];
  readonly patterns?: string | RegExp | (string | RegExp)[];
  readonly repos?: string | RegExp | (string | RegExp)[];

  readonly description?: string;
}

// --- Status trigger ---

export type StatusState = 'error' | 'failure' | 'pending' | 'success';

/** Commit status trigger config. */
export interface StatusTriggerConfig {
  readonly _tag: 'StatusTrigger';
  readonly contexts: readonly string[];
  readonly states: readonly StatusState[];
  readonly repos: readonly BranchPattern[];

  readonly description?: string;
}

/** Input for `status()`. */
export interface StatusConfigInput {
  readonly contexts?: string[];
  readonly states?: StatusState[];
  readonly repos?: string | RegExp | (string | RegExp)[];

  readonly description?: string;
}

// --- Workflow run trigger ---

export type WorkflowRunAction = 'requested' | 'completed' | 'in_progress';

/** workflow_run trigger config. */
export interface WorkflowRunTriggerConfig {
  readonly _tag: 'WorkflowRunTrigger';
  readonly actions: readonly WorkflowRunAction[];
  readonly workflows: readonly string[];
  readonly conclusions: readonly string[];
  readonly repos: readonly BranchPattern[];

  readonly description?: string;
}

/** Input for `workflowRun()`. */
export interface WorkflowRunConfigInput {
  readonly actions?: WorkflowRunAction[];
  readonly workflows?: string[];
  readonly conclusions?: string[];
  readonly repos?: string | RegExp | (string | RegExp)[];

  readonly description?: string;
}

// --- Fork trigger ---

/** Fork trigger config; it has no filter fields. */
export interface ForkTriggerConfig {
  readonly _tag: 'ForkTrigger';
  readonly repos: readonly BranchPattern[];

  readonly description?: string;
}

/** Input for `fork()`. */
export interface ForkConfigInput {
  readonly repos?: string | RegExp | (string | RegExp)[];

  readonly description?: string;
}

// --- Star trigger ---

export type StarAction = 'created' | 'deleted';

export interface StarTriggerConfig {
  readonly _tag: 'StarTrigger';
  readonly actions: readonly StarAction[];
  readonly repos: readonly BranchPattern[];

  readonly description?: string;
}

/** Input for `star()`. */
export interface StarConfigInput {
  readonly actions?: StarAction[];
  readonly repos?: string | RegExp | (string | RegExp)[];

  readonly description?: string;
}

// --- Watch trigger ---

export type WatchAction = 'started';

export interface WatchTriggerConfig {
  readonly _tag: 'WatchTrigger';
  readonly actions: readonly WatchAction[];
  readonly repos: readonly BranchPattern[];

  readonly description?: string;
}

/** Input for `watch()`. */
export interface WatchConfigInput {
  readonly actions?: WatchAction[];
  readonly repos?: string | RegExp | (string | RegExp)[];

  readonly description?: string;
}

// --- KiCI event trigger ---

/** Input for `kiciEvent()`. `name` is required: identifies the custom event to listen for. */
export interface KiciEventConfigInput {
  readonly name: string;
  readonly match?: Record<string, unknown>;
  readonly source?: string;
  readonly not?: Record<string, unknown>;
  readonly description?: string;
}

export interface KiciEventTriggerConfig {
  readonly _tag: 'KiciEventTrigger';
  readonly name: string;
  readonly match?: Record<string, unknown>;
  readonly source?: string;
  readonly not?: Record<string, unknown>;
  readonly description?: string;
}

// --- Workflow complete trigger ---

export type WorkflowCompleteStatus = 'success' | 'failed' | 'cancelled';

/** Input for `workflowComplete()`. */
export interface WorkflowCompleteConfigInput {
  readonly name?: string;
  readonly status?: WorkflowCompleteStatus[];
  readonly source?: string;
  readonly description?: string;
}

export interface WorkflowCompleteTriggerConfig {
  readonly _tag: 'WorkflowCompleteTrigger';
  readonly name?: string;
  readonly status?: readonly string[];
  readonly source?: string;
  readonly description?: string;
}

// --- Workflows failed batch trigger ---

/** Input for `workflowsFailedBatch()`: accumulate failed workflow completions over a window, notify once. */
export interface WorkflowsFailedBatchConfigInput {
  /** Accumulation window in milliseconds; the window opens on the first failure. */
  readonly accumulateFor: number;
  readonly name?: string;
  readonly source?: string;
  readonly description?: string;
}

export interface WorkflowsFailedBatchTriggerConfig {
  readonly _tag: 'WorkflowsFailedBatchTrigger';
  /** Accumulation window in milliseconds; the window opens on the first failure. */
  readonly accumulateFor: number;
  readonly name?: string;
  readonly source?: string;
  readonly description?: string;
}

// --- Job complete trigger ---

export type JobCompleteStatus = 'success' | 'failed' | 'cancelled' | 'skipped';

/** Input for `jobComplete()`. */
export interface JobCompleteConfigInput {
  readonly workflow?: string;
  readonly job?: string;
  readonly status?: JobCompleteStatus[];
  readonly source?: string;
  readonly description?: string;
}

export interface JobCompleteTriggerConfig {
  readonly _tag: 'JobCompleteTrigger';
  readonly workflow?: string;
  readonly job?: string;
  readonly status?: readonly string[];
  readonly source?: string;
  readonly description?: string;
}

// --- Generic webhook trigger ---

/** Generic webhook verification method. */
export type GenericWebhookAuthMethod = 'hmac-sha256' | 'api-key';

export interface GenericWebhookHmacAuth {
  readonly method: 'hmac-sha256';
  /** Name of the secret containing the HMAC signing key */
  readonly secret: string;
  /** Header containing the signature (e.g., 'x-hub-signature-256', 'stripe-signature') */
  readonly signatureHeader: string;
}

export interface GenericWebhookApiKeyAuth {
  readonly method: 'api-key';
  /** Name of the secret containing the API key value */
  readonly secret: string;
  /** Header to check for the API key (defaults to 'authorization') */
  readonly header?: string;
}

export type GenericWebhookAuth = GenericWebhookHmacAuth | GenericWebhookApiKeyAuth;

/** Input for `genericWebhook()`. `source` is required: identifies the webhook source. */
export interface GenericWebhookConfigInput {
  readonly source: string;
  readonly events?: string[];
  readonly match?: Record<string, unknown>;
  readonly not?: Record<string, unknown>;
  readonly auth?: GenericWebhookAuth;
  /** URL path pattern (replaces source for URL matching; source becomes alias for path) */
  readonly path?: string;
  readonly description?: string;
}

export interface GenericWebhookTriggerConfig {
  readonly _tag: 'GenericWebhookTrigger';
  readonly source: string;
  readonly events?: readonly string[];
  readonly match?: Record<string, unknown>;
  readonly not?: Record<string, unknown>;
  readonly auth?: GenericWebhookAuth;
  readonly path?: string;
  readonly description?: string;
}

// --- Schedule trigger ---

/** Input for `schedule()`. */
export interface ScheduleConfigInput {
  readonly cron: string;
  readonly timezone?: string;
  readonly description?: string;
  /**
   * Typed schedule inputs (defaults-only — no operator overrides on a fire).
   * Accepts a bare `{ name: ZodSchema }` map or a `defineDispatchInputs(...)`
   * branded handle. Each input must declare a `.default()` or be `.optional()`
   * (enforced at compile time).
   */
  readonly inputs?:
    DispatchInputsMap | { readonly __kiciDispatchInputs: true; readonly map: DispatchInputsMap };
}

export interface ScheduleTriggerConfig {
  readonly _tag: 'ScheduleTrigger';
  readonly cron: string;
  readonly timezone: string;
  readonly description?: string;
  /** Declared, typed schedule inputs (frozen `{ name: ZodSchema }`). */
  readonly inputs?: DispatchInputsMap;
}

// --- Lifecycle trigger ---

/** Lifecycle events for cross-workflow orchestration. */
export type LifecycleEvent =
  'workflow_complete' | 'job_complete' | 'job_failed' | 'registration_updated';

/** Input for `lifecycle()`. */
export interface LifecycleConfigInput {
  readonly events: LifecycleEvent[];
  readonly sources?: string[];
  readonly description?: string;
}

export interface LifecycleTriggerConfig {
  readonly _tag: 'LifecycleTrigger';
  readonly events: readonly LifecycleEvent[];
  readonly sources?: readonly string[];
  readonly description?: string;
}

// --- Webhook (catch-all) trigger ---

export interface WebhookTriggerConfig {
  readonly _tag: 'WebhookTrigger';
  readonly events: readonly string[];
  readonly actions: readonly string[];
  readonly repos: readonly BranchPattern[];

  readonly description?: string;
}

/** Input for `webhook()`. `events` is required: catch-all must specify what to catch. */
export interface WebhookConfigInput {
  readonly events: string[];
  readonly actions?: string[];
  readonly repos?: string | RegExp | (string | RegExp)[];

  readonly description?: string;
}

// --- Union types ---

/** Union of every trigger configuration. */
export type TriggerConfig =
  | PrTriggerConfig
  | PushTriggerConfig
  | TagTriggerConfig
  | CommentTriggerConfig
  | ReviewTriggerConfig
  | ReviewCommentTriggerConfig
  | ReleaseTriggerConfig
  | DispatchTriggerConfig
  | CreateTriggerConfig
  | DeleteTriggerConfig
  | StatusTriggerConfig
  | WorkflowRunTriggerConfig
  | ForkTriggerConfig
  | StarTriggerConfig
  | WatchTriggerConfig
  | WebhookTriggerConfig
  | KiciEventTriggerConfig
  | WorkflowCompleteTriggerConfig
  | WorkflowsFailedBatchTriggerConfig
  | JobCompleteTriggerConfig
  | GenericWebhookTriggerConfig
  | ScheduleTriggerConfig
  | LifecycleTriggerConfig;

/** Input for `pr()`; every field is optional and has a default. */
export interface PrConfigInput {
  readonly events?: PrEvent[];
  readonly target?: string | RegExp | (string | RegExp)[];
  readonly source?: string | RegExp | (string | RegExp)[];
  readonly paths?: string[];

  readonly repos?: string | RegExp | (string | RegExp)[];

  /** Declarative static content filter over source files at the event ref (AND-ed). */
  readonly requires?: readonly ContentRequirement[];
  /** Declarative static filter over the event's commit message / PR title+body. */
  readonly commitMessage?: TextMatch;

  readonly description?: string;
}

/** Input for `push()`; every field is optional and has a default. */
export interface PushConfigInput {
  readonly branches?: string | RegExp | (string | RegExp)[];
  readonly tags?: string | RegExp | (string | RegExp)[];
  readonly paths?: string[];

  readonly repos?: string | RegExp | (string | RegExp)[];

  /** Declarative static content filter over source files at the event ref (AND-ed). */
  readonly requires?: readonly ContentRequirement[];
  /** Declarative static filter over the event's commit message / PR title+body. */
  readonly commitMessage?: TextMatch;

  readonly description?: string;
}

/**
 * Strings become glob patterns, RegExp becomes regex patterns.
 *
 * `g` and `y` are dropped from the author's flags: the matcher memoizes one
 * `RegExp` per (flags, pattern), and a sticky instance carries `lastIndex`
 * between calls — so `/^release-\d+/g` would match `release-1`, miss
 * `release-2`, and match `release-3`, silently skipping every second push.
 */
export function toBranchPattern(input: string | RegExp): BranchPattern {
  if (input instanceof RegExp) {
    return {
      type: 'regex',
      pattern: input.source,
      flags: normalizeRegexFlags(input.flags),
    };
  }
  return {
    type: 'glob',
    pattern: input,
  };
}

/** Normalize a single value or an array to an array. */
export function asArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}
