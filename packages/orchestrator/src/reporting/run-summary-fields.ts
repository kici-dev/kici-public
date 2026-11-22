/**
 * The run fields every `onExecutionStatusChange` context built from an in-memory run carries,
 * in one place so no status transition silently drops a new column.
 */
import type { ExecutionContext } from './execution-tracker.js';

type RunSummaryKey =
  | 'workflowName'
  | 'provider'
  | 'repoIdentifier'
  | 'workflowRepoIdentifier'
  | 'sha'
  | 'installationId'
  | 'githubUrl'
  | 'githubSourceMissing'
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

/** A run's server fields, each copied only when set (a github.com run carries neither). */
export function githubServerFields(
  run: Pick<ExecutionContext, 'githubUrl' | 'githubSourceMissing'>,
): Pick<ExecutionContext, 'githubUrl' | 'githubSourceMissing'> {
  return {
    ...(run.githubUrl && { githubUrl: run.githubUrl }),
    ...(run.githubSourceMissing && { githubSourceMissing: true }),
  };
}

/** The `statusEpoch` context field for a run, omitted at 0 (its default). */
export function statusEpochField(epoch: number | null | undefined): { statusEpoch?: number } {
  return epoch ? { statusEpoch: epoch } : {};
}

/**
 * `workflowRepoIdentifier` is copied only when set: its presence marks a cross-repository
 * global run downstream. `githubUrl` is copied only when set, so a github.com run's
 * context gains no key. `localWorkingTree` is left to the caller (only some transitions
 * forward it).
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
    ...githubServerFields(run),
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
