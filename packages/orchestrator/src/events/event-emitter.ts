import type { EventRouter } from './event-router.js';
import {
  SCALER_EVENT_NAMES,
  ScalerScaleUpPayload,
  ScalerScaleDownPayload,
  type ScalerScaleUpPayload as ScalerScaleUpPayloadType,
  type ScalerScaleDownPayload as ScalerScaleDownPayloadType,
} from '../scaler/scaler-events.js';

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
  /**
   * Per-job results. `outputs` carries a job's non-secret declared outputs
   * (additive/optional — an invoke gate reads them to surface an invoked run's
   * outputs to downstream global jobs; older readers ignore the field).
   */
  jobResults: Array<{ name: string; status: string; outputs?: Record<string, unknown> }>;
  /** Why the run failed (`RunFailureClass`); carried on the event so Plane B can route on it. */
  failureClass?: string;
}

/** One failed run carried in a workflows_failed_batch event. */
export interface WorkflowsFailedBatchRun {
  runId: string;
  repo: string;
  workflowName: string;
  failureClass?: string;
  senderUsername?: string;
}

/**
 * Input data for emitting a __workflows_failed_batch system event.
 * One event per swept accumulation window; `registrationId` targets the single
 * subscribing workflow so the batch dispatches once.
 */
export interface WorkflowsFailedBatchData {
  routingKey: string;
  repo: string;
  registrationId: string;
  /** Total failed runs in the window (may exceed `runs.length` when capped). */
  total: number;
  runs: WorkflowsFailedBatchRun[];
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
        ...(data.failureClass && { failureClass: data.failureClass }),
      },
      sourceRepo: data.repo,
      sourceRoutingKey: data.routingKey,
      sourceRunId: data.runId,
      chainDepth: 0,
    });
  }

  /**
   * Emit a __workflows_failed_batch system event: one synthetic event per swept
   * accumulation window carrying the batched failed runs. Targeted at the single
   * subscribing registration via `payload.registrationId` so the batch workflow
   * dispatches exactly once, no matter how many failures landed in the window.
   * Returns the event ID as delivery receipt.
   */
  async emitWorkflowsFailedBatch(data: WorkflowsFailedBatchData): Promise<string> {
    return this.router.emit({
      eventName: '__workflows_failed_batch',
      payload: {
        registrationId: data.registrationId,
        total: data.total,
        runs: data.runs,
        sourceRepo: data.repo,
        sourceRoutingKey: data.routingKey,
      },
      sourceRepo: data.repo,
      sourceRoutingKey: data.routingKey,
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

  /**
   * Emit a `kici.scaler.scale-up` system event. Delivered to the scaler's
   * `provisioningTargets` (the workflow refs that provision cloud instances),
   * carrying everything a provisioning workflow needs — including a single-use
   * claim code. Root-level (chainDepth 0), rate-exempt via the reserved `kici.`
   * prefix. Returns the event id as a delivery receipt.
   */
  async emitScalerScaleUp(payload: ScalerScaleUpPayloadType, targets: string[]): Promise<string> {
    const validated = ScalerScaleUpPayload.parse(payload);
    return this.router.emit({
      eventName: SCALER_EVENT_NAMES.scaleUp,
      payload: validated,
      target: { repos: targets },
      chainDepth: 0,
    });
  }

  /**
   * Emit a `kici.scaler.scale-down` system event. Delivered to the scaler's
   * `provisioningTargets` so a teardown workflow deletes the instance
   * registered under `payload.agentId`. Root-level (chainDepth 0), rate-exempt.
   * Returns the event id as a delivery receipt.
   */
  async emitScalerScaleDown(
    payload: ScalerScaleDownPayloadType,
    targets: string[],
  ): Promise<string> {
    const validated = ScalerScaleDownPayload.parse(payload);
    return this.router.emit({
      eventName: SCALER_EVENT_NAMES.scaleDown,
      payload: validated,
      target: { repos: targets },
      chainDepth: 0,
    });
  }
}
