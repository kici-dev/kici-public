/**
 * Build the `execution.status` frame the orchestrator forwards to the Platform.
 * A pure function with its own tests: `server.ts`'s `onExecutionStatusChange`
 * hook supplies the message id and the clock and hands the result to the
 * Platform client.
 *
 * Every field is conditional on the context carrying it. For
 * `workflowRepoIdentifier` that is load-bearing: the tracker records it only
 * when the repository that defines the workflow differs from the one the run
 * acted on, so its presence marks a cross-repository global run downstream.
 * Free text is clamped to the wire bound here, at the source.
 *
 * A run from a GitHub Enterprise Server source names its server in
 * `repoWebUrl`, and its actor in that server's identity namespace
 * (`github:<host>`): user ids are numbered per server. A github.com run's
 * frame carries neither difference.
 */
import type { ExecutionContext } from '../reporting/execution-tracker.js';
import {
  clampInitFailure,
  clampStatusFreeText,
  SourceProvider,
  type ExecutionRunStatus,
  type ExecutionStatus,
  type InitFailure,
} from '@kici-dev/engine';
import { githubIdentityProvider } from '../providers/github/github-host.js';

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

/**
 * The identity namespace of the run's actor: per server for GitHub, the
 * provider otherwise. Undefined when the run's GitHub source is gone, so its
 * server is unknown: the frame then names no namespace, and the Platform keeps
 * the one it stored.
 */
function actorProvider(context: ExecutionContext): string | undefined {
  if (context.provider !== SourceProvider.enum.github) return context.provider;
  // fails-when: a run whose GHES source was removed names its actor as a github.com user
  if (context.githubSourceMissing) return undefined;
  // fails-when: a GHES actor is attributed as a github.com user with the same id
  // breaks-if-wrong: a github.com run keeps 'github'; other providers keep their name
  return githubIdentityProvider(context.githubUrl);
}

export function buildExecutionStatusFrame(args: ExecutionStatusFrameArgs): ExecutionStatus {
  const { context } = args;
  const actorNamespace = context.provider ? actorProvider(context) : undefined;
  return {
    type: 'execution.status',
    messageId: args.messageId,
    runId: args.runId,
    workflowName: context.workflowName,
    status: args.status,
    ...(context.routingKey && { routingKey: context.routingKey }),
    repoIdentifier: context.repoIdentifier,
    // The tracker sets it only when the defining repository differs from the
    // source one, so its presence marks a global run on the Platform side.
    ...(context.workflowRepoIdentifier && {
      workflowRepoIdentifier: context.workflowRepoIdentifier,
    }),
    // Present only for a global evaluation round's own run row, which the
    // Platform mirrors to tell a round from a workflow run.
    ...(context.isGlobalEvalRound === true && { isGlobalEvalRound: true }),
    ...(context.provider && { repoProvider: context.provider }),
    ...(context.githubUrl && { repoWebUrl: context.githubUrl }),
    ...(context.localWorkingTree && { localWorkingTree: true }),
    sha: context.sha,
    ...(context.ref && { ref: context.ref }),
    ...(context.triggerEvent && { triggerEvent: context.triggerEvent }),
    ...(context.commitMessage && { commitMessage: clampStatusFreeText(context.commitMessage) }),
    ...(context.parentRunId != null && { parentRunId: context.parentRunId }),
    ...(context.originalRunId != null && { originalRunId: context.originalRunId }),
    ...(context.triggeredBy != null && { triggeredBy: context.triggeredBy }),
    ...(context.triggeredByAgentLabel != null && {
      triggeredByAgentLabel: context.triggeredByAgentLabel,
    }),
    ...((context.triggerActorUsername != null || context.triggerActorUserId != null) &&
      actorNamespace && { triggerActorProvider: actorNamespace }),
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
    ...(args.failureReason !== undefined && {
      failureReason: clampStatusFreeText(args.failureReason),
    }),
    ...(args.logBytes !== undefined && { logBytes: args.logBytes }),
    ...(args.initFailure && { initFailure: clampInitFailure(args.initFailure) }),
    ...(context.failureClass && { failureClass: context.failureClass }),
    // Always sent: the Platform applies its keep-terminal rule only to a frame
    // that carries a generation, and reads one without it as an older
    // orchestrator's. 0 is a run that never left a terminal status.
    statusEpoch: context.statusEpoch ?? 0,
  };
}
