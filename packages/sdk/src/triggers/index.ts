/**
 * Trigger helpers for defining when workflows run.
 */

// Factory functions
export { pr } from './pr.js';
export { push } from './push.js';
export { tag } from './tag.js';
export { comment } from './comment.js';
export { review } from './review.js';
export { reviewComment } from './review-comment.js';
export { release } from './release.js';
export { dispatch } from './dispatch.js';
export { create } from './create.js';
export { del as delete } from './delete.js';
export { status } from './status.js';
export { workflowRun } from './workflow-run.js';
export { fork } from './fork.js';
export { star } from './star.js';
export { watch } from './watch.js';
export { webhook } from './webhook.js';
export { kiciEvent } from './kici-event.js';
export { workflowComplete } from './workflow-complete.js';
export { jobComplete } from './job-complete.js';
export { genericWebhook } from './generic-webhook.js';
export { schedule } from './schedule.js';
export { lifecycle } from './lifecycle.js';
export { defineDispatchInputs } from './dispatch-inputs.js';
export type { DefinedDispatchInputs, InferDispatchInputs } from './dispatch-inputs.js';

// Types
export type {
  DispatchInputsMap,
  BranchPattern,
  BodyMatchPattern,
  PrEvent,
  PushEvent,
  PrTriggerConfig,
  PushTriggerConfig,
  TagTriggerConfig,
  CommentTriggerConfig,
  ReviewTriggerConfig,
  ReviewCommentTriggerConfig,
  ReleaseTriggerConfig,
  DispatchTriggerConfig,
  CreateTriggerConfig,
  DeleteTriggerConfig,
  StatusTriggerConfig,
  WorkflowRunTriggerConfig,
  ForkTriggerConfig,
  StarTriggerConfig,
  WatchTriggerConfig,
  WebhookTriggerConfig,
  TriggerConfig,
  PrConfigInput,
  PushConfigInput,
  TagConfigInput,
  CommentConfigInput,
  CommentAction,
  CommentSource,
  ReviewConfigInput,
  ReviewAction,
  ReviewState,
  ReviewCommentConfigInput,
  ReviewCommentAction,
  ReleaseConfigInput,
  ReleaseAction,
  DispatchConfigInput,
  CreateConfigInput,
  DeleteConfigInput,
  RefType,
  StatusConfigInput,
  StatusState,
  WorkflowRunConfigInput,
  WorkflowRunAction,
  ForkConfigInput,
  StarConfigInput,
  StarAction,
  WatchConfigInput,
  WatchAction,
  WebhookConfigInput,
  KiciEventConfigInput,
  KiciEventTriggerConfig,
  WorkflowCompleteConfigInput,
  WorkflowCompleteTriggerConfig,
  WorkflowCompleteStatus,
  JobCompleteConfigInput,
  JobCompleteTriggerConfig,
  JobCompleteStatus,
  GenericWebhookConfigInput,
  GenericWebhookTriggerConfig,
  GenericWebhookAuthMethod,
  GenericWebhookHmacAuth,
  GenericWebhookApiKeyAuth,
  GenericWebhookAuth,
  ScheduleConfigInput,
  ScheduleTriggerConfig,
  LifecycleEvent,
  LifecycleConfigInput,
  LifecycleTriggerConfig,
} from './types.js';

export { DEFAULT_PR_EVENTS, toBranchPattern } from './types.js';
