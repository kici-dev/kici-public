/**
 * The worker-side half of the reroute spawn-retry agreement.
 *
 * A coordinator reroutes a job to this worker with a spawn-retry budget
 * (`job.reroute.spawnRetry`). This module applies it:
 *
 * - every scaler request for the job passes a per-job attempt gate, so one spawn
 *   is in flight at a time and none starts during the backoff;
 * - each `scaler.failed` is relayed to the owning coordinator with the budget's
 *   verdict (`final`), and the last one releases the job from this worker's queue;
 * - a coordinator's cancel releases a queued job and stop-marks a dispatched one.
 *
 * Assembled here so `bootstrapWorker` only wires it.
 */
import {
  ScalerEventType,
  type JobReroute,
  type PeerScalerEvent,
  type RerouteSpawnRetry,
} from '@kici-dev/engine';
import type { Dispatcher } from '../agent/dispatcher.js';
import type { ScalerManager } from '../scaler/manager.js';
import type { ScaleResult, ScalerEvent } from '../scaler/types.js';
import { runDetached } from '../helpers/run-detached.js';
import type { InMemoryJobQueue } from './in-memory-job-queue.js';
import type { InMemoryExecutionTracker } from './in-memory-execution-tracker.js';
import { releaseQueuedRerouteJobs } from './queued-reroute-release.js';
import { SpawnAttemptGate, SpawnRetryBudget, type FailureVerdict } from './spawn-retry-budget.js';

/** The scaler request the dispatcher's `onNoMatchingAgent` makes. */
export type ScaleRequest = (
  ...args: Parameters<ScalerManager['requestScale']>
) => Promise<ScaleResult>;

export interface RerouteSpawnControlDeps {
  queue: InMemoryJobQueue;
  /** Late-bound: the scaler that emits events is built before the dispatcher. */
  getDispatcher: () => Pick<Dispatcher, 'cancelQueuedJob' | 'redrivePendingJob'>;
  executionTracker: InMemoryExecutionTracker;
  /** jobId → owning coordinator URL. */
  jobOwnership: Map<string, string>;
  /** Relay a message to the coordinator that owns the job. */
  sendToOwningCoord: (jobId: string, msg: PeerScalerEvent) => void;
  /** The worker's configured budget, used when the coordinator sent none. */
  defaults: RerouteSpawnRetry;
  logger: {
    debug(message: string, meta?: Record<string, unknown>): unknown;
    info(message: string, meta?: Record<string, unknown>): unknown;
    warn(message: string, meta?: Record<string, unknown>): unknown;
    error(message: string, meta?: Record<string, unknown>): unknown;
  };
}

export interface RerouteSpawnControl {
  /** Start the job's budget. Call before the job is dispatched. */
  registerReroute(msg: JobReroute): void;
  /** Drop the budget of a reroute this worker did not accept. */
  forgetReroute(jobId: string): void;
  /** Gate a scaler request through the job's budget. */
  wrapScaleRequest(fn: ScaleRequest): ScaleRequest;
  /** Relay a scaler event to the owning coordinator, with the budget's verdict. */
  onScalerEvent(runId: string, jobId: string, ev: ScalerEvent): void;
  /** An agent received the job. */
  onDelivered(jobId: string): void;
  /** The job reached a terminal state. */
  onJobTerminal(jobId: string): void;
  /** The owning coordinator cancelled the run, or one job of it. */
  releaseQueued(runId: string, jobId: string | undefined): Promise<string[]>;
}

export function createRerouteSpawnControl(deps: RerouteSpawnControlDeps): RerouteSpawnControl {
  const { logger } = deps;
  const budget = new SpawnRetryBudget({
    isQueued: (jobId) => deps.queue.isPending(jobId),
    redrive: (jobId) => deps.getDispatcher().redrivePendingJob(jobId),
    logger,
  });

  const release = (runId: string, jobId: string | undefined, reason: string) =>
    releaseQueuedRerouteJobs(
      {
        queue: deps.queue,
        dispatcher: deps.getDispatcher(),
        executionTracker: deps.executionTracker,
        jobOwnership: deps.jobOwnership,
        budget,
      },
      { runId, jobId, reason },
    );

  return {
    registerReroute(msg) {
      budget.register(msg.jobId, msg.runId, msg.spawnRetry ?? deps.defaults);
    },

    forgetReroute(jobId) {
      budget.release(jobId);
    },

    wrapScaleRequest(fn) {
      return async (labels, jobId, runId, ...rest) => {
        const gate = budget.beginAttempt(jobId);
        if (gate !== SpawnAttemptGate.enum.untracked && gate !== SpawnAttemptGate.enum.begun) {
          return { action: 'skipped', reason: `rerouted job spawn ${gate}` };
        }
        let result: ScaleResult;
        try {
          result = await fn(labels, jobId, runId, ...rest);
        } catch (err) {
          if (gate === SpawnAttemptGate.enum.begun) budget.abortAttempt(jobId);
          throw err;
        }
        if (gate === SpawnAttemptGate.enum.begun) {
          if (result.action === 'spawning') budget.setHolder(jobId, result.agentId);
          else if (result.action === 'skipped' && result.retryAfterMs !== undefined) {
            budget.deferAttempt(jobId, result.retryAfterMs);
          } else budget.abortAttempt(jobId);
        }
        return result;
      };
    },

    onScalerEvent(runId, jobId, ev) {
      const verdict: FailureVerdict =
        ev.eventType === ScalerEventType.enum['scaler.failed']
          ? budget.recordFailure(jobId, ev.agentId)
          : { tracked: false };
      // Relay before releasing: the relay reads the job's owner, which the release deletes.
      // A repeated report of one failed spawn carries no verdict: the coordinator
      // counts every `final: false` as one spent attempt.
      deps.sendToOwningCoord(jobId, {
        type: 'scaler.event',
        runId,
        jobId,
        agentId: ev.agentId,
        eventType: ev.eventType,
        detail: ev.detail,
        timestampMs: ev.timestampMs,
        ...(verdict.tracked && !verdict.duplicate && { final: verdict.final }),
      });
      if (!verdict.tracked || !verdict.final || verdict.duplicate) return;
      logger.warn('Rerouted job spawn retries exhausted — releasing it to its coordinator', {
        runId,
        jobId,
        failures: verdict.failures,
        maxAttempts: verdict.maxAttempts,
      });
      runDetached(
        logger,
        'Release exhausted rerouted job',
        () => release(runId, jobId, 'spawn retries exhausted'),
        { runId, jobId },
      );
    },

    onDelivered(jobId) {
      budget.onDelivered(jobId);
    },

    onJobTerminal(jobId) {
      budget.release(jobId);
    },

    releaseQueued(runId, jobId) {
      return release(runId, jobId, 'cancelled by the coordinator');
    },
  };
}
