/**
 * Lock file types. The engine owns every `Lock*` shape; the compiler re-exports
 * them so the lock it writes and the lock the orchestrator reads share one
 * declaration. Only the discovery-time types below are compiler-specific.
 */

export {
  SCHEMA_VERSION,
  BREAKING_FLOOR,
  isLockParallelStep,
  isLockStaticJob,
  isLockDynamicJobFn,
  type LockApproval,
  type LockSource,
  type LockBranchPattern,
  type LockPrTrigger,
  type LockPushTrigger,
  type LockTagTrigger,
  type LockCommentTrigger,
  type LockReviewTrigger,
  type LockReviewCommentTrigger,
  type LockReleaseTrigger,
  type LockDispatchTrigger,
  type LockCreateTrigger,
  type LockDeleteTrigger,
  type LockStatusTrigger,
  type LockWorkflowRunTrigger,
  type LockForkTrigger,
  type LockStarTrigger,
  type LockWatchTrigger,
  type LockWebhookTrigger,
  type LockKiciEventTrigger,
  type LockWorkflowCompleteTrigger,
  type LockWorkflowsFailedBatchTrigger,
  type LockJobCompleteTrigger,
  type LockGenericWebhookAuth,
  type LockGenericWebhookTrigger,
  type LockScheduleTrigger,
  type LockLifecycleTrigger,
  type LockTrigger,
  type LockMatrix,
  type LockRule,
  type LockStep,
  type LockParallelStep,
  type LockStepEntry,
  type LockNeedsEntry,
  type LockNeedsGroupEntry,
  type LockJob,
  type LockDynamicJobFn,
  type LockJobOrFactory,
  type LockRegistry,
  type LockWorkflow,
  type LockFile,
} from '@kici-dev/engine';

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
