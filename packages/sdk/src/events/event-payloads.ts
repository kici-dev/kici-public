/**
 * Typed event payload discriminated union for rule authors.
 *
 * Provides autocomplete when narrowing on `ctx.event.type` in rule functions.
 * Each variant carries partial GitHub payload types for the most commonly
 * accessed fields. The index signature on each payload interface allows
 * accessing fields not explicitly typed (they resolve to `unknown`).
 *
 * The runtime shape mirrors SimulatedEvent from @kici-dev/engine — these types
 * are the user-facing view of the same data. Keep them in sync when adding new
 * event types or SimulatedEvent fields.
 */

// ---------------------------------------------------------------------------
// GitHub payload sub-types (partial — only commonly accessed fields)
// ---------------------------------------------------------------------------

/** Partial GitHub repository object. */
export interface GitHubRepository {
  full_name: string;
  default_branch: string;
  name?: string;
  owner?: { login: string; [key: string]: unknown };
  private?: boolean;
  [key: string]: unknown;
}

/** Partial GitHub user/sender object. */
export interface GitHubUser {
  login: string;
  id?: number;
  [key: string]: unknown;
}

/** Partial GitHub pull request object. */
export interface GitHubPullRequest {
  number: number;
  draft?: boolean;
  title?: string;
  body?: string;
  state?: string;
  merged?: boolean;
  head: {
    ref: string;
    sha: string;
    repo?: { full_name: string; [key: string]: unknown };
    [key: string]: unknown;
  };
  base: {
    ref: string;
    repo?: { full_name: string; [key: string]: unknown };
    [key: string]: unknown;
  };
  user?: GitHubUser;
  labels?: Array<{ name: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

/** Partial GitHub commit object (from push events). */
export interface GitHubCommit {
  id: string;
  message: string;
  author?: { name?: string; email?: string; username?: string; [key: string]: unknown };
  timestamp?: string;
  added?: string[];
  removed?: string[];
  modified?: string[];
  [key: string]: unknown;
}

/** Partial GitHub comment object (issue_comment events). */
export interface GitHubComment {
  id: number;
  body: string;
  user: GitHubUser;
  [key: string]: unknown;
}

/** Partial GitHub review object. */
export interface GitHubReview {
  id: number;
  state: string;
  body?: string;
  user: GitHubUser;
  [key: string]: unknown;
}

/** Partial GitHub release object. */
export interface GitHubRelease {
  id: number;
  tag_name: string;
  name?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  target_commitish?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Event base — shared normalized fields (mirrors SimulatedEvent)
// ---------------------------------------------------------------------------

/** Base fields present on all event payloads. */
export interface EventBase {
  /** Normalized event type discriminant. */
  type: string;
  /** Sub-action (e.g. 'opened', 'created', 'submitted'). */
  action?: string;
  /** Target branch (push target, PR base, or default branch). */
  targetBranch?: string;
  /** Source branch (PR head branch). Only set for PR-like events. */
  sourceBranch?: string;
  /** Provider that originated this event. */
  provider?: string;
  /** Whether this PR comes from a fork. Only set for PR-like events. */
  isForkPR?: boolean;
  /** Base branch ref for PR events. */
  baseBranch?: string;
  /** Sender username from the webhook payload. */
  senderUsername?: string;
  /** Repository identifier (e.g. "owner/repo"). */
  sourceRepo?: string;
  /** Files changed in this event (for path filtering). */
  changedFiles?: string[];
  /** Raw webhook payload from the provider. May be absent in flattened event forms. */
  payload?: Record<string, unknown>;
  /** Index signature for backward compatibility — untyped fields resolve to unknown. */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Per-event-type payload interfaces
// ---------------------------------------------------------------------------

/** Pull request event payload. */
export interface PullRequestEventPayload extends EventBase {
  type: 'pull_request';
  action: string;
  payload: {
    action: string;
    number: number;
    pull_request: GitHubPullRequest;
    repository: GitHubRepository;
    sender: GitHubUser;
    [key: string]: unknown;
  };
}

/** Push event payload. */
export interface PushEventPayload extends EventBase {
  type: 'push';
  payload: {
    ref: string;
    after: string;
    before: string;
    head_commit?: GitHubCommit;
    commits?: GitHubCommit[];
    repository: GitHubRepository;
    sender?: GitHubUser;
    forced?: boolean;
    [key: string]: unknown;
  };
}

/** Tag push event payload. */
export interface TagEventPayload extends EventBase {
  type: 'tag';
  payload: {
    ref: string;
    after: string;
    repository: GitHubRepository;
    sender?: GitHubUser;
    [key: string]: unknown;
  };
}

/** Issue/PR comment event payload. */
export interface CommentEventPayload extends EventBase {
  type: 'comment';
  action: string;
  payload: {
    action: string;
    comment: GitHubComment;
    issue?: { number: number; title?: string; pull_request?: unknown; [key: string]: unknown };
    repository: GitHubRepository;
    sender: GitHubUser;
    [key: string]: unknown;
  };
}

/** Pull request review event payload. */
export interface ReviewEventPayload extends EventBase {
  type: 'review';
  action: string;
  payload: {
    action: string;
    review: GitHubReview;
    pull_request: GitHubPullRequest;
    repository: GitHubRepository;
    sender: GitHubUser;
    [key: string]: unknown;
  };
}

/** Pull request review comment event payload. */
export interface ReviewCommentEventPayload extends EventBase {
  type: 'review_comment';
  action: string;
  payload: {
    action: string;
    comment: GitHubComment;
    pull_request: GitHubPullRequest;
    repository: GitHubRepository;
    sender: GitHubUser;
    [key: string]: unknown;
  };
}

/** Release event payload. */
export interface ReleaseEventPayload extends EventBase {
  type: 'release';
  action: string;
  payload: {
    action: string;
    release: GitHubRelease;
    repository: GitHubRepository;
    sender: GitHubUser;
    [key: string]: unknown;
  };
}

/** Repository dispatch event payload. */
export interface DispatchEventPayload extends EventBase {
  type: 'dispatch';
  payload: {
    action: string;
    client_payload?: Record<string, unknown>;
    repository: GitHubRepository;
    sender?: GitHubUser;
    [key: string]: unknown;
  };
}

/** Branch/tag create event payload. */
export interface CreateEventPayload extends EventBase {
  type: 'create';
  payload: {
    ref: string;
    ref_type: string;
    repository: GitHubRepository;
    sender: GitHubUser;
    [key: string]: unknown;
  };
}

/** Branch/tag delete event payload. */
export interface DeleteEventPayload extends EventBase {
  type: 'delete';
  payload: {
    ref: string;
    ref_type: string;
    repository: GitHubRepository;
    sender: GitHubUser;
    [key: string]: unknown;
  };
}

/** Commit status event payload. */
export interface StatusEventPayload extends EventBase {
  type: 'status';
  payload: {
    state: string;
    sha: string;
    context: string;
    description?: string;
    target_url?: string;
    branches?: Array<{ name: string; [key: string]: unknown }>;
    repository: GitHubRepository;
    sender: GitHubUser;
    [key: string]: unknown;
  };
}

/** Workflow run event payload. */
export interface WorkflowRunEventPayload extends EventBase {
  type: 'workflow_run';
  action: string;
  payload: {
    action: string;
    workflow_run: {
      head_branch: string;
      name: string;
      conclusion?: string;
      status?: string;
      [key: string]: unknown;
    };
    repository: GitHubRepository;
    sender: GitHubUser;
    [key: string]: unknown;
  };
}

/** Fork event payload. */
export interface ForkEventPayload extends EventBase {
  type: 'fork';
  payload: {
    forkee: { full_name: string; [key: string]: unknown };
    repository: GitHubRepository;
    sender: GitHubUser;
    [key: string]: unknown;
  };
}

/** Star event payload. */
export interface StarEventPayload extends EventBase {
  type: 'star';
  action: string;
  payload: {
    action: string;
    repository: GitHubRepository;
    sender: GitHubUser;
    [key: string]: unknown;
  };
}

/** Watch event payload. */
export interface WatchEventPayload extends EventBase {
  type: 'watch';
  action: string;
  payload: {
    action: string;
    repository: GitHubRepository;
    sender: GitHubUser;
    [key: string]: unknown;
  };
}

// --- Events with generic payloads (no provider-specific typing) ---

/** Webhook trigger event payload. */
export interface WebhookEventPayload extends EventBase {
  type: 'webhook';
}

/** Custom KiCI event payload (emitted via ctx.emit). */
export interface KiciEventPayload extends EventBase {
  type: 'kici_event';
}

/** Workflow complete internal event payload. */
export interface WorkflowCompleteEventPayload extends EventBase {
  type: 'workflow_complete';
}

/** Job complete internal event payload. */
export interface JobCompleteEventPayload extends EventBase {
  type: 'job_complete';
}

/** Generic webhook event payload. */
export interface GenericWebhookEventPayload extends EventBase {
  type: 'generic_webhook';
}

/** Schedule (cron) event payload. */
export interface ScheduleEventPayload extends EventBase {
  type: 'schedule';
}

/** Lifecycle event payload. */
export interface LifecycleEventPayload extends EventBase {
  type: 'lifecycle';
}

/** Re-run event payload. */
export interface RerunEventPayload extends EventBase {
  type: 'rerun';
}

/** Manual schedule event payload. */
export interface ManualScheduleEventPayload extends EventBase {
  type: 'manual_schedule';
}

/**
 * Compile-time fallback member of the {@link EventPayload} union for event
 * types not yet modeled here.
 *
 * Its `type` is the literal `'unknown'` (not `string`) so that the union stays
 * a *proper* discriminated union — a non-literal discriminant would collapse
 * narrowing on `event.type` for every other member. At runtime, an event of an
 * unmodeled kind still carries its real type string in `event.type`; this
 * interface only governs how TypeScript narrows it. Code that must handle
 * arbitrary future types can compare the raw value via `String(event.type) ===
 * '...'`, or use the {@link isEventType} guard for the known types.
 */
export interface UnknownEventPayload extends EventBase {
  type: 'unknown';
}

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

/**
 * Typed event payload — discriminated union over the `type` field.
 *
 * Narrow with `if (ctx.event.type === 'pull_request')` to get autocomplete
 * on provider-specific fields like `ctx.event.payload.pull_request.draft`.
 *
 * For unrecognized event types, falls back to {@link UnknownEventPayload}
 * which retains the index signature for backward-compatible property access.
 */
export type EventPayload =
  | PullRequestEventPayload
  | PushEventPayload
  | TagEventPayload
  | CommentEventPayload
  | ReviewEventPayload
  | ReviewCommentEventPayload
  | ReleaseEventPayload
  | DispatchEventPayload
  | CreateEventPayload
  | DeleteEventPayload
  | StatusEventPayload
  | WorkflowRunEventPayload
  | ForkEventPayload
  | StarEventPayload
  | WatchEventPayload
  | WebhookEventPayload
  | KiciEventPayload
  | WorkflowCompleteEventPayload
  | JobCompleteEventPayload
  | GenericWebhookEventPayload
  | ScheduleEventPayload
  | LifecycleEventPayload
  | RerunEventPayload
  | ManualScheduleEventPayload
  | UnknownEventPayload;

// ---------------------------------------------------------------------------
// Type guard helper
// ---------------------------------------------------------------------------

/**
 * Narrow an EventPayload to a specific event type.
 *
 * @example
 * ```ts
 * rule('only-draft-prs', (ctx) => {
 *   if (!isEventType(ctx.event, 'pull_request')) return false;
 *   // ctx.event is now PullRequestEventPayload
 *   return ctx.event.payload.pull_request.draft === true;
 * });
 * ```
 */
export function isEventType<T extends EventPayload['type']>(
  event: EventPayload,
  type: T,
): event is Extract<EventPayload, { type: T }> {
  return event.type === type;
}
