/**
 * Build the `job.status.forward` frame the orchestrator forwards to the Platform.
 *
 * Every optional field is sent only when the tracker supplied it, so the
 * Platform reads an absent field as "no value" and keeps what it stored. Free
 * text is clamped to the wire bound here, at the source, so a long agent error
 * never produces a frame the Platform has to shorten.
 */
import {
  clampInitFailure,
  clampStatusFreeText,
  type ExecutionJobStatus,
  type InitFailure,
  type JobStatusForward,
} from '@kici-dev/engine';

export interface JobStatusForwardFrameArgs {
  messageId: string;
  runId: string;
  jobId: string;
  jobName: string;
  status: ExecutionJobStatus;
  timestamp: number;
  orchestratorId: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  errorMessage?: string;
  agentId?: string;
  runsOnLabels?: string[];
  logBytes?: number;
  initFailure?: InitFailure;
  /** Ordered bound context names for a multi-context job. */
  contexts?: string[];
}

export function buildJobStatusForwardFrame(args: JobStatusForwardFrameArgs): JobStatusForward {
  return {
    type: 'job.status.forward',
    messageId: args.messageId,
    runId: args.runId,
    jobId: args.jobId,
    jobName: args.jobName,
    status: args.status,
    timestamp: args.timestamp,
    ...(args.startedAt !== undefined && { startedAt: args.startedAt }),
    ...(args.completedAt !== undefined && { completedAt: args.completedAt }),
    ...(args.durationMs !== undefined && { durationMs: args.durationMs }),
    ...(args.errorMessage !== undefined && {
      errorMessage: clampStatusFreeText(args.errorMessage),
    }),
    ...(args.logBytes !== undefined && { logBytes: args.logBytes }),
    ...(args.agentId && { agentId: args.agentId }),
    ...(args.runsOnLabels?.length && { runsOnLabels: args.runsOnLabels }),
    ...(args.contexts?.length && { contexts: args.contexts }),
    ...(args.initFailure && { initFailure: clampInitFailure(args.initFailure) }),
    orchestratorId: args.orchestratorId,
  };
}
