// Factory functions
export { step } from './step.js';
export { job } from './job.js';
export { workflow } from './workflow.js';

// Approval gate API
export { normalizeRequireApproval } from './approval.js';
export type { RequireApproval, ApproverClause, NormalizedRequireApproval } from './approval.js';

// Trigger factories
export {
  pr,
  push,
  tag,
  comment,
  review,
  reviewComment,
  release,
  dispatch,
  create,
  delete as delete,
  status,
  workflowRun,
  fork,
  star,
  watch,
  webhook,
  kiciEvent,
  workflowComplete,
  jobComplete,
  genericWebhook,
  schedule,
  lifecycle,
} from './triggers/index.js';
export type {
  TriggerConfig,
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
  BranchPattern,
  BodyMatchPattern,
  PrEvent,
  PushEvent,
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
} from './triggers/index.js';

// Hook factories
export { onCancel, cleanup, onSuccess, onFailure, beforeStep, afterStep } from './hooks/index.js';
export type { HookConfig, HookFn, HookInput, HookContext, OutcomeMetadata } from './hooks/index.js';

// Rule factories
export { rule, skip } from './rules/index.js';
export { evaluateRules } from './rules/index.js';
export { isEventType } from './rules/index.js';
export type {
  Rule,
  RuleContext,
  RuleCheckFn,
  RuleResult,
  EventPayload,
  RuleEvaluationResult,
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
} from './rules/index.js';

// Validation utilities
export { validateDag } from './validation/index.js';
export type { DagNode, DagValidationResult } from './validation/index.js';

// Types
export type {
  SourceLocation,
  OutputProxy,
  Step,
  StepOptions,
  StepOptionsBase,
  StepOptionsPlain,
  StepOptionsWithCheck,
  StepRunFn,
  BareStepFn,
  StepInput,
  OutputSchema,
  InferOutputs,
  Job,
  JobOptions,
  GenericInitConfig,
  MiseInitConfig,
  InitPreset,
  InitItem,
  InitConfig,
  ContainerConfig,
  RunsOnSelector,
  RunsOn,
  Workflow,
  WorkflowOptions,
  Registry,
  Trigger,
  DynamicJobFn,
  DynamicJobContext,
  JobOrFactory,
} from './types.js';

export {
  isDynamicJobFn,
  dynamicJob,
  getDynamicJobGroup,
  getDynamicJobNeeds,
  DYNAMIC_JOB_GROUP_TAG,
  DYNAMIC_JOB_NEEDS_TAG,
} from './types.js';
export type {
  TaggedDynamicJobFn,
  ResultAwareDynamicJobConfig,
  ResultAwareDynamicJobFn,
  DynamicJobNeed,
} from './types.js';

// Result-aware dynamic job generation: ctx.needs builder + snapshot proxy
export { buildNeedsContext } from './needs-context.js';
export type { UpstreamSnapshot, NeedsContext, NeedEntry, GroupNeedEntry } from './needs-context.js';

// Cache types
export { CacheSpecSchema, normalizeCacheSpecs } from './cache-types.js';
export type { CacheSpec, CacheInput } from './cache-types.js';
export type { CacheRestoreResult, CacheApi } from './cache-types.js';
export { provenanceSubjectIsPath } from './provenance-types.js';
export type {
  AttestProvenanceOptions,
  AttestProvenanceResult,
  ProvenanceSubjectInput,
} from './provenance-types.js';

// Dynamic group helpers (cross-domain needs)
export { dynamicGroup, isDynamicGroupRef, DYNAMIC_GROUP_TAG } from './dynamic-group.js';
export type { DynamicGroupRef } from './dynamic-group.js';

export type {
  StepContext,
  Logger,
  WorkflowInfo,
  JobInfo,
  AgentInfo,
  MatrixJobOutputs,
  HostJobOutputs,
  RepoInfo,
  StepSecretsTyped,
  KnownSecretKeys,
} from './context.js';

export { isMatrixJobOutputs, isHostJobOutputs } from './context.js';

// KiCI API types (agent private API over WS)
export { buildKiciApi } from './api-types.js';
export type {
  KiciApi,
  KiciApiTransport,
  InfrastructureApi,
  InfrastructureListResult,
  InventoryApi,
  HostInventoryEntry,
  InventorySelector,
} from './api-types.js';

// Error types
export { SecretNotFoundError } from './errors.js';

// Secrets factory
export { createStepSecrets } from './secrets.js';
export type {
  StepSecrets,
  TrackedStepSecrets,
  SecretMeta,
  SecretFileOptions,
  MountedFile,
  StepSecretsFileHost,
  StepSecretsFileWiring,
  StepSecretsHandle,
  StepSecretMountKind,
  StepSecretMountRecord,
} from './secrets.js';

// Output proxy infrastructure
export {
  createStepOutputProxy,
  createJobOutputProxy,
  createSnapshotOutputProxy,
  resolveStepOutputs,
  resolveJobOutputs,
  setStepOutputsMap,
  setJobOutputsMap,
  setStepRefMap,
  getStepOutputsMap,
  getJobOutputsMap,
  getStepRefMap,
} from './outputs.js';
export type { OutputsMap, StepRefMap } from './outputs.js';

// Matrix types
export type {
  StaticMatrixArray,
  StaticMatrixObject,
  DynamicMatrixFn,
  DynamicMatrixContext,
  Matrix,
  MatrixInclude,
  MatrixExclude,
  MatrixValues,
} from './matrix/index.js';

export { isStaticArray, isStaticObject, isDynamicFunction } from './matrix/index.js';

// Matrix expansion utilities
export { expandMatrix, applyIncludeExclude } from './matrix/index.js';

// Event definitions
export { defineEvent } from './events/index.js';
export type { EventDefinition } from './events/index.js';
export type { EventEmitOptions } from './events/index.js';

// Fixture factory
export { fixture } from './fixture.js';
export type { Fixture, FixtureOptions } from './fixture.js';

// Idempotency helpers
export { idempotent, idempotentStep } from './idempotent.js';
export type { IdempotentOptions, IdempotentResult } from './idempotent.js';

// Wait-for helpers
export { waitFor, waitForStep, WaitForTimeoutError } from './wait-for.js';
export type { WaitForOptions, WaitForResult } from './wait-for.js';

// Zod re-export for event schema authoring
export { z } from 'zod';
