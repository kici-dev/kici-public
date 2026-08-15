/**
 * Build the `execution.status` frame the orchestrator forwards to the Platform.
 *
 * Extracted from `server.ts`'s `onExecutionStatusChange` hook so the projection
 * from an {@link ExecutionContext} onto the wire message is a pure function with
 * its own tests. The hook itself stays a thin adapter: it supplies the message
 * id and the clock and hands the result to the Platform client.
 *
 * Every field here is conditional on the context actually carrying it. That is
 * load-bearing for `workflowRepoIdentifier` in particular: the tracker records
 * it only when the repository that DEFINES the workflow differs from the
 * repository the run acted on, so the frame must stay silent for a per-repository
 * run or "present" stops marking a cross-repository global run downstream.
 */
import type { ExecutionContext } from '../reporting/execution-tracker.js';
import type { ExecutionRunStatus, ExecutionStatus, InitFailure } from '@kici-dev/engine';

export interface ExecutionStatusFrameArgs {
  messageId: string;
  runId: string;
  status: ExecutionRunStatus;
  context: ExecutionContext;
  jobCount: number;
  startedAt: number;
  timestamp: number;
  completedAt?: number;
  durationMs?: number;
  failureReason?: string;
  logBytes?: number;
  initFailure?: InitFailure;
}

export function buildExecutionStatusFrame(args: ExecutionStatusFrameArgs): ExecutionStatus {
  const { context } = args;
  return {
    type: 'execution.status',
    messageId: args.messageId,
    runId: args.runId,
    workflowName: context.workflowName,
    status: args.status,
    ...(context.routingKey && { routingKey: context.routingKey }),
    repoIdentifier: context.repoIdentifier,
    // Present only for a cross-repository global run — the tracker sets it only
    // when the defining repository differs from the source one, which is what
    // makes its presence a reliable "global run" marker on the Platform side.
    ...(context.workflowRepoIdentifier && {
      workflowRepoIdentifier: context.workflowRepoIdentifier,
    }),
    ...(context.provider && { repoProvider: context.provider }),
    ...(context.localWorkingTree && { localWorkingTree: true }),
    sha: context.sha,
    ...(context.ref && { ref: context.ref }),
    ...(context.triggerEvent && { triggerEvent: context.triggerEvent }),
    ...(context.commitMessage && { commitMessage: context.commitMessage }),
    ...(context.parentRunId != null && { parentRunId: context.parentRunId }),
    ...(context.originalRunId != null && { originalRunId: context.originalRunId }),
    ...(context.triggeredBy != null && { triggeredBy: context.triggeredBy }),
    ...(context.triggeredByAgentLabel != null && {
      triggeredByAgentLabel: context.triggeredByAgentLabel,
    }),
    ...((context.triggerActorUsername != null || context.triggerActorUserId != null) &&
      context.provider && { triggerActorProvider: context.provider }),
    ...(context.triggerActorUsername != null && {
      triggerActorUsername: context.triggerActorUsername,
    }),
    ...(context.triggerActorUserId != null && {
      triggerActorUserId: context.triggerActorUserId,
    }),
    jobCount: args.jobCount,
    startedAt: args.startedAt,
    timestamp: args.timestamp,
    ...(args.completedAt !== undefined && { completedAt: args.completedAt }),
    ...(args.durationMs !== undefined && { durationMs: args.durationMs }),
    ...(args.failureReason !== undefined && { failureReason: args.failureReason }),
    ...(args.logBytes !== undefined && { logBytes: args.logBytes }),
    ...(args.initFailure && { initFailure: args.initFailure }),
    ...(context.failureClass && { failureClass: context.failureClass }),
  };
}
