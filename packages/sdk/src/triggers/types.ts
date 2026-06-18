/**
 * Trigger types and interfaces for pr() and push() trigger helpers.
 * Supports both glob patterns and regex patterns for branch/path matching.
 */

/**
 * Branch pattern - discriminated union supporting both glob and regex patterns.
 * Glob patterns use micromatch syntax, regex patterns use standard JS regex.
 */
export type BranchPattern =
  | { readonly type: 'glob'; readonly pattern: string }
  | { readonly type: 'regex'; readonly pattern: string; readonly flags?: string };

/**
 * All supported GitHub PR event types.
 */
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

/**
 * Default PR events when pr() is called without explicit events.
 */
export const DEFAULT_PR_EVENTS: readonly PrEvent[] = [
  'opened',
  'synchronize',
  'reopened',
  'closed',
] as const;

/**
 * Push event type (currently only 'push').
 */
export type PushEvent = 'push';

/**
 * Configuration for a PR trigger.
 */
export interface PrTriggerConfig {
  readonly _tag: 'PrTrigger';
  readonly events: readonly PrEvent[];
  readonly targetBranches: readonly BranchPattern[];
  readonly sourceBranches: readonly BranchPattern[];
  readonly paths: readonly string[];
  readonly repos: readonly BranchPattern[];
  readonly description?: string;
}

/**
 * Configuration for a push trigger.
 */
export interface PushTriggerConfig {
  readonly _tag: 'PushTrigger';
  readonly branches: readonly BranchPattern[];
  readonly tags: readonly BranchPattern[];
  readonly paths: readonly string[];
  readonly repos: readonly BranchPattern[];
  readonly description?: string;
}

// --- Tag trigger ---

/**
 * Configuration for a tag trigger.
 */
export interface TagTriggerConfig {
  readonly _tag: 'TagTrigger';
  readonly patterns: readonly BranchPattern[];
  readonly repos: readonly BranchPattern[];
  readonly description?: string;
}

/**
 * Input configuration for tag() factory function.
 */
export interface TagConfigInput {
  readonly patterns?: string | RegExp | (string | RegExp)[];
  readonly repos?: string | RegExp | (string | RegExp)[];
  readonly description?: string;
}

// --- Comment trigger ---

export type CommentAction = 'created' | 'edited' | 'deleted';

export type CommentSource = 'issue' | 'pr';

/**
 * Serialized body match pattern for comment triggers.
 */
export type BodyMatchPattern =
  | { readonly type: 'glob'; readonly pattern: string }
  | { readonly type: 'regex'; readonly pattern: string; readonly flags?: string };

/**
 * Configuration for a comment trigger (issue_comment / PR review comment).
 */
export interface CommentTriggerConfig {
  readonly _tag: 'CommentTrigger';
  readonly actions: readonly CommentAction[];
  readonly source?: CommentSource;
  readonly bodyMatch?: BodyMatchPattern;
  readonly repos: readonly BranchPattern[];
  readonly description?: string;
}

/**
 * Input configuration for comment() factory function.
 */
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

/**
 * Configuration for a pull request review trigger.
 */
export interface ReviewTriggerConfig {
  readonly _tag: 'ReviewTrigger';
  readonly actions: readonly ReviewAction[];
  readonly states: readonly ReviewState[];
  readonly repos: readonly BranchPattern[];

  readonly description?: string;
}

/**
 * Input configuration for review() factory function.
 */
export interface ReviewConfigInput {
  readonly actions?: ReviewAction[];
  readonly states?: ReviewState[];
  readonly repos?: string | RegExp | (string | RegExp)[];

  readonly description?: string;
}

// --- Review comment trigger ---

export type ReviewCommentAction = 'created' | 'edited' | 'deleted';

/**
 * Configuration for a pull request review comment trigger.
 */
export interface ReviewCommentTriggerConfig {
  readonly _tag: 'ReviewCommentTrigger';
  readonly actions: readonly ReviewCommentAction[];
  readonly repos: readonly BranchPattern[];

  readonly description?: string;
}

/**
 * Input configuration for reviewComment() factory function.
 */
export interface ReviewCommentConfigInput {
  readonly actions?: ReviewCommentAction[];
  readonly repos?: string | RegExp | (string | RegExp)[];

  readonly description?: string;
}

// --- Release trigger ---

export type ReleaseAction =
  | 'published'
  | 'unpublished'
  | 'created'
  | 'edited'
  | 'deleted'
  | 'prereleased'
  | 'released';

/**
 * Configuration for a release trigger.
 */
export interface ReleaseTriggerConfig {
  readonly _tag: 'ReleaseTrigger';
  readonly actions: readonly ReleaseAction[];
  readonly repos: readonly BranchPattern[];

  readonly description?: string;
}

/**
 * Input configuration for release() factory function.
 */
export interface ReleaseConfigInput {
  readonly actions?: ReleaseAction[];
  readonly repos?: string | RegExp | (string | RegExp)[];

  readonly description?: string;
}

// --- Dispatch trigger ---

/**
 * Configuration for a repository_dispatch trigger.
 */
export interface DispatchTriggerConfig {
  readonly _tag: 'DispatchTrigger';
  readonly types: readonly string[];
  readonly repos: readonly BranchPattern[];

  readonly description?: string;
}

/**
 * Input configuration for dispatch() factory function.
 */
export interface DispatchConfigInput {
  readonly types?: string[];
  readonly repos?: string | RegExp | (string | RegExp)[];

  readonly description?: string;
}

// --- Create trigger ---

export type RefType = 'branch' | 'tag';

/**
 * Configuration for a create ref trigger.
 */
export interface CreateTriggerConfig {
  readonly _tag: 'CreateTrigger';
  readonly refTypes: readonly RefType[];
  readonly patterns: readonly BranchPattern[];
  readonly repos: readonly BranchPattern[];

  readonly description?: string;
}

/**
 * Input configuration for create() factory function.
 */
export interface CreateConfigInput {
  readonly refTypes?: RefType[];
  readonly patterns?: string | RegExp | (string | RegExp)[];
  readonly repos?: string | RegExp | (string | RegExp)[];

  readonly description?: string;
}

// --- Delete trigger ---

/**
 * Configuration for a delete ref trigger.
 */
export interface DeleteTriggerConfig {
  readonly _tag: 'DeleteTrigger';
  readonly refTypes: readonly RefType[];
  readonly patterns: readonly BranchPattern[];
  readonly repos: readonly BranchPattern[];

  readonly description?: string;
}

/**
 * Input configuration for delete() factory function.
 */
export interface DeleteConfigInput {
  readonly refTypes?: RefType[];
  readonly patterns?: string | RegExp | (string | RegExp)[];
  readonly repos?: string | RegExp | (string | RegExp)[];

  readonly description?: string;
}

// --- Status trigger ---

export type StatusState = 'error' | 'failure' | 'pending' | 'success';

/**
 * Configuration for a commit status trigger.
 */
export interface StatusTriggerConfig {
  readonly _tag: 'StatusTrigger';
  readonly contexts: readonly string[];
  readonly states: readonly StatusState[];
  readonly repos: readonly BranchPattern[];

  readonly description?: string;
}

/**
 * Input configuration for status() factory function.
 */
export interface StatusConfigInput {
  readonly contexts?: string[];
  readonly states?: StatusState[];
  readonly repos?: string | RegExp | (string | RegExp)[];

  readonly description?: string;
}

// --- Workflow run trigger ---

export type WorkflowRunAction = 'requested' | 'completed' | 'in_progress';

/**
 * Configuration for a workflow_run trigger.
 */
export interface WorkflowRunTriggerConfig {
  readonly _tag: 'WorkflowRunTrigger';
  readonly actions: readonly WorkflowRunAction[];
  readonly workflows: readonly string[];
  readonly conclusions: readonly string[];
  readonly repos: readonly BranchPattern[];

  readonly description?: string;
}

/**
 * Input configuration for workflowRun() factory function.
 */
export interface WorkflowRunConfigInput {
  readonly actions?: WorkflowRunAction[];
  readonly workflows?: string[];
  readonly conclusions?: string[];
  readonly repos?: string | RegExp | (string | RegExp)[];

  readonly description?: string;
}

// --- Fork trigger ---

/**
 * Configuration for a fork trigger. No filter fields.
 */
export interface ForkTriggerConfig {
  readonly _tag: 'ForkTrigger';
  readonly repos: readonly BranchPattern[];

  readonly description?: string;
}

/**
 * Input configuration for fork() factory function.
 */
export interface ForkConfigInput {
  readonly repos?: string | RegExp | (string | RegExp)[];

  readonly description?: string;
}

// --- Star trigger ---

export type StarAction = 'created' | 'deleted';

/**
 * Configuration for a star trigger.
 */
export interface StarTriggerConfig {
  readonly _tag: 'StarTrigger';
  readonly actions: readonly StarAction[];
  readonly repos: readonly BranchPattern[];

  readonly description?: string;
}

/**
 * Input configuration for star() factory function.
 */
export interface StarConfigInput {
  readonly actions?: StarAction[];
  readonly repos?: string | RegExp | (string | RegExp)[];

  readonly description?: string;
}

// --- Watch trigger ---

export type WatchAction = 'started';

/**
 * Configuration for a watch trigger.
 */
export interface WatchTriggerConfig {
  readonly _tag: 'WatchTrigger';
  readonly actions: readonly WatchAction[];
  readonly repos: readonly BranchPattern[];

  readonly description?: string;
}

/**
 * Input configuration for watch() factory function.
 */
export interface WatchConfigInput {
  readonly actions?: WatchAction[];
  readonly repos?: string | RegExp | (string | RegExp)[];

  readonly description?: string;
}

// --- KiCI event trigger ---

/**
 * Input configuration for kiciEvent() factory function.
 * `name` is required -- identifies the custom event to listen for.
 */
export interface KiciEventConfigInput {
  readonly name: string;
  readonly match?: Record<string, unknown>;
  readonly source?: string;
  readonly not?: Record<string, unknown>;
  readonly description?: string;
}

/**
 * Configuration for a KiCI custom event trigger.
 */
export interface KiciEventTriggerConfig {
  readonly _tag: 'KiciEventTrigger';
  readonly name: string;
  readonly match?: Record<string, unknown>;
  readonly source?: string;
  readonly not?: Record<string, unknown>;
  readonly description?: string;
}

// --- Workflow complete trigger ---

/**
 * Valid workflow completion statuses.
 */
export type WorkflowCompleteStatus = 'success' | 'failed' | 'cancelled';

/**
 * Input configuration for workflowComplete() factory function.
 */
export interface WorkflowCompleteConfigInput {
  readonly name?: string;
  readonly status?: WorkflowCompleteStatus[];
  readonly source?: string;
  readonly description?: string;
}

/**
 * Configuration for a workflow completion trigger.
 */
export interface WorkflowCompleteTriggerConfig {
  readonly _tag: 'WorkflowCompleteTrigger';
  readonly name?: string;
  readonly status?: readonly string[];
  readonly source?: string;
  readonly description?: string;
}

// --- Job complete trigger ---

/**
 * Valid job completion statuses.
 */
export type JobCompleteStatus = 'success' | 'failed' | 'cancelled' | 'skipped';

/**
 * Input configuration for jobComplete() factory function.
 */
export interface JobCompleteConfigInput {
  readonly workflow?: string;
  readonly job?: string;
  readonly status?: JobCompleteStatus[];
  readonly source?: string;
  readonly description?: string;
}

/**
 * Configuration for a job completion trigger.
 */
export interface JobCompleteTriggerConfig {
  readonly _tag: 'JobCompleteTrigger';
  readonly workflow?: string;
  readonly job?: string;
  readonly status?: readonly string[];
  readonly source?: string;
  readonly description?: string;
}

// --- Generic webhook trigger ---

/**
 * Auth method for generic webhook verification.
 */
export type GenericWebhookAuthMethod = 'hmac-sha256' | 'api-key';

/**
 * HMAC-SHA256 auth config for generic webhooks.
 */
export interface GenericWebhookHmacAuth {
  readonly method: 'hmac-sha256';
  /** Name of the secret containing the HMAC signing key */
  readonly secret: string;
  /** Header containing the signature (e.g., 'x-hub-signature-256', 'stripe-signature') */
  readonly signatureHeader: string;
}

/**
 * API key auth config for generic webhooks.
 */
export interface GenericWebhookApiKeyAuth {
  readonly method: 'api-key';
  /** Name of the secret containing the API key value */
  readonly secret: string;
  /** Header to check for the API key (defaults to 'authorization') */
  readonly header?: string;
}

/**
 * Union of generic webhook auth configurations.
 */
export type GenericWebhookAuth = GenericWebhookHmacAuth | GenericWebhookApiKeyAuth;

/**
 * Input configuration for genericWebhook() factory function.
 * `source` is required -- identifies the webhook source.
 */
export interface GenericWebhookConfigInput {
  readonly source: string;
  readonly events?: string[];
  readonly match?: Record<string, unknown>;
  readonly not?: Record<string, unknown>;
  /** Auth configuration for webhook verification */
  readonly auth?: GenericWebhookAuth;
  /** URL path pattern (replaces source for URL matching; source becomes alias for path) */
  readonly path?: string;
  readonly description?: string;
}

/**
 * Configuration for a generic webhook trigger.
 */
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

/**
 * Input configuration for schedule() factory function.
 */
export interface ScheduleConfigInput {
  readonly cron: string;
  readonly timezone?: string;
  readonly description?: string;
}

/**
 * Configuration for a schedule trigger.
 */
export interface ScheduleTriggerConfig {
  readonly _tag: 'ScheduleTrigger';
  readonly cron: string;
  readonly timezone: string;
  readonly description?: string;
}

// --- Lifecycle trigger ---

/**
 * Lifecycle event types for cross-workflow orchestration.
 */
export type LifecycleEvent =
  | 'workflow_complete'
  | 'job_complete'
  | 'job_failed'
  | 'registration_updated';

/**
 * Input configuration for lifecycle() factory function.
 */
export interface LifecycleConfigInput {
  readonly events: LifecycleEvent[];
  readonly sources?: string[];
  readonly description?: string;
}

/**
 * Configuration for a lifecycle trigger.
 */
export interface LifecycleTriggerConfig {
  readonly _tag: 'LifecycleTrigger';
  readonly events: readonly LifecycleEvent[];
  readonly sources?: readonly string[];
  readonly description?: string;
}

// --- Webhook (catch-all) trigger ---

/**
 * Configuration for a catch-all webhook trigger.
 */
export interface WebhookTriggerConfig {
  readonly _tag: 'WebhookTrigger';
  readonly events: readonly string[];
  readonly actions: readonly string[];
  readonly repos: readonly BranchPattern[];

  readonly description?: string;
}

/**
 * Input configuration for webhook() factory function.
 * `events` is required -- catch-all must specify what to catch.
 */
export interface WebhookConfigInput {
  readonly events: string[];
  readonly actions?: string[];
  readonly repos?: string | RegExp | (string | RegExp)[];

  readonly description?: string;
}

// --- Union types ---

/**
 * Union type for all trigger configurations (21 types).
 */
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
  | JobCompleteTriggerConfig
  | GenericWebhookTriggerConfig
  | ScheduleTriggerConfig
  | LifecycleTriggerConfig;

/**
 * Input configuration for pr() factory function.
 * All fields optional - sensible defaults applied.
 */
export interface PrConfigInput {
  readonly events?: PrEvent[];
  readonly target?: string | RegExp | (string | RegExp)[];
  readonly source?: string | RegExp | (string | RegExp)[];
  readonly paths?: string[];

  readonly repos?: string | RegExp | (string | RegExp)[];

  readonly description?: string;
}

/**
 * Input configuration for push() factory function.
 * All fields optional - sensible defaults applied.
 */
export interface PushConfigInput {
  readonly branches?: string | RegExp | (string | RegExp)[];
  readonly tags?: string | RegExp | (string | RegExp)[];
  readonly paths?: string[];

  readonly repos?: string | RegExp | (string | RegExp)[];

  readonly description?: string;
}

/**
 * Convert a string or RegExp to a BranchPattern.
 * Strings become glob patterns, RegExp becomes regex patterns.
 */
export function toBranchPattern(input: string | RegExp): BranchPattern {
  if (input instanceof RegExp) {
    return {
      type: 'regex',
      pattern: input.source,
      flags: input.flags || undefined,
    };
  }
  return {
    type: 'glob',
    pattern: input,
  };
}

/**
 * Helper to normalize single value or array to array.
 */
export function asArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}
