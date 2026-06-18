import type { EventRouter } from './event-router.js';

/**
 * Input data for emitting a workflow_complete system event.
 */
export interface WorkflowCompleteData {
  routingKey: string;
  repo: string;
  workflowName: string;
  runId: string;
  status: string;
  conclusion: string;
  duration: number;
  jobResults: Array<{ name: string; status: string }>;
}

/**
 * Input data for emitting a job_complete system event.
 */
export interface JobCompleteData {
  routingKey: string;
  repo: string;
  workflowName: string;
  jobName: string;
  runId: string;
  jobId: string;
  status: string;
  duration: number;
  stepResults: Array<{ name: string; status: string }>;
}

/**
 * EventEmitter automatically generates system events when workflows and jobs complete.
 *
 * System events are root-level (chainDepth: 0) since they originate from the
 * orchestrator, not from a chain of events.
 */
export class EventEmitter {
  constructor(private readonly router: EventRouter) {}

  /**
   * Emit a __workflow_complete system event with rich metadata.
   * Returns the event ID as delivery receipt.
   */
  async emitWorkflowComplete(data: WorkflowCompleteData): Promise<string> {
    return this.router.emit({
      eventName: '__workflow_complete',
      payload: {
        workflowName: data.workflowName,
        runId: data.runId,
        status: data.status,
        conclusion: data.conclusion,
        duration: data.duration,
        jobResults: data.jobResults,
        sourceRepo: data.repo,
        sourceRoutingKey: data.routingKey,
      },
      sourceRepo: data.repo,
      sourceRoutingKey: data.routingKey,
      sourceRunId: data.runId,
      chainDepth: 0,
    });
  }

  /**
   * Emit a __job_complete system event with rich metadata.
   * Returns the event ID as delivery receipt.
   */
  async emitJobComplete(data: JobCompleteData): Promise<string> {
    return this.router.emit({
      eventName: '__job_complete',
      payload: {
        workflowName: data.workflowName,
        jobName: data.jobName,
        runId: data.runId,
        jobId: data.jobId,
        status: data.status,
        duration: data.duration,
        stepResults: data.stepResults,
        sourceRepo: data.repo,
        sourceRoutingKey: data.routingKey,
      },
      sourceRepo: data.repo,
      sourceRoutingKey: data.routingKey,
      sourceRunId: data.runId,
      sourceJobId: data.jobId,
      chainDepth: 0,
    });
  }
}
