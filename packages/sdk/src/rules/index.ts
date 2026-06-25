// Factory functions
export { rule, skip, onlyOnFirstHost, onlyOnLastHost, onlyOnFanoutIndex } from './rule.js';

// Rule evaluator
export { evaluateRules, type RuleEvaluationResult } from './evaluator.js';

// Types
export type { Rule, RuleCheckFn, RuleContext, RuleResult, EventPayload } from './types.js';

// Event payload type guard
export { isEventType } from '../events/event-payloads.js';

// Event payload per-type interfaces (for explicit narrowing)
export type {
  EventBase,
  PullRequestEventPayload,
  PushEventPayload,
  TagEventPayload,
  CommentEventPayload,
  ReviewEventPayload,
  ReviewCommentEventPayload,
  ReleaseEventPayload,
  DispatchEventPayload,
  CreateEventPayload,
  DeleteEventPayload,
  StatusEventPayload,
  WorkflowRunEventPayload,
  ForkEventPayload,
  StarEventPayload,
  WatchEventPayload,
  WebhookEventPayload,
  KiciEventPayload,
  WorkflowCompleteEventPayload,
  JobCompleteEventPayload,
  GenericWebhookEventPayload,
  ScheduleEventPayload,
  LifecycleEventPayload,
  GitHubRepository,
  GitHubUser,
  GitHubPullRequest,
  GitHubCommit,
  GitHubComment,
  GitHubReview,
  GitHubRelease,
} from '../events/event-payloads.js';
