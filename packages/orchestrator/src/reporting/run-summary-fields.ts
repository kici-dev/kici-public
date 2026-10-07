/**
 * The run fields every `onExecutionStatusChange` context built from an
 * in-memory run carries, in one place so a new column cannot be forwarded from
 * some status transitions and silently dropped from others.
 */
import type { ExecutionContext } from './execution-tracker.js';

type RunSummaryKey =
  | 'workflowName'
  | 'provider'
  | 'repoIdentifier'
  | 'workflowRepoIdentifier'
  | 'sha'
  | 'installationId'
  | 'requestId'
  | 'routingKey'
  | 'ref'
  | 'triggerEvent'
  | 'commitMessage'
  | 'parentRunId'
  | 'originalRunId'
  | 'triggeredBy'
  | 'triggeredByAgentLabel'
  | 'triggerActorUsername'
  | 'triggerActorUserId';

/** The slice of a tracked run {@link runSummaryFields} reads. */
export type RunSummarySource = Pick<ExecutionContext, RunSummaryKey> & {
  statusEpoch?: number | null;
};

/** The `statusEpoch` context field for a run, omitted at 0 (its default). */
export function statusEpochField(epoch: number | null | undefined): { statusEpoch?: number } {
  return epoch ? { statusEpoch: epoch } : {};
}

/**
 * The shared part of a run's status-change context.
 *
 * `workflowRepoIdentifier` is copied only when set, because its presence is
 * what marks a cross-repository global run downstream. `localWorkingTree` is
 * left to the caller: only some transitions forward it.
 */
export function runSummaryFields(
  run: RunSummarySource,
): Pick<ExecutionContext, RunSummaryKey | 'statusEpoch'> {
  return {
    workflowName: run.workflowName,
    ...statusEpochField(run.statusEpoch),
    provider: run.provider,
    repoIdentifier: run.repoIdentifier,
    ...(run.workflowRepoIdentifier && { workflowRepoIdentifier: run.workflowRepoIdentifier }),
    sha: run.sha,
    installationId: run.installationId,
    requestId: run.requestId,
    routingKey: run.routingKey,
    ref: run.ref,
    triggerEvent: run.triggerEvent,
    commitMessage: run.commitMessage,
    parentRunId: run.parentRunId,
    originalRunId: run.originalRunId,
    triggeredBy: run.triggeredBy,
    triggeredByAgentLabel: run.triggeredByAgentLabel,
    triggerActorUsername: run.triggerActorUsername,
    triggerActorUserId: run.triggerActorUserId,
  };
}
