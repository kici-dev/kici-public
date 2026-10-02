/**
 * The receiving end of `peer.job.cancel`.
 *
 * A sibling forwards a cancel to the coordinator its agent is connected to,
 * which it reads from the host roster. That coordinator's dispatcher tracks the
 * job only when it dispatched or re-adopted it: an agent that reconnected here
 * from a sibling, or one not yet back after this process restarted, is known
 * only to `dispatch_queue.agent_id`. So the agent is resolved from the
 * dispatcher first and from the dispatch record second, and a cancel that
 * cannot be delivered is logged with the reason.
 *
 * On a worker the receiver also removes the jobs of the cancel that are still
 * queued (waiting for an agent spawn), and stop-marks the dispatched ones so a
 * requeue cannot bring them back. A removed job is reported `dequeued`.
 */
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { toErrorMessage } from '@kici-dev/shared';
import type { PeerJobCancel } from '@kici-dev/engine';
import type { Database } from '../db/types.js';
import type { AgentRegistry } from '../agent/registry.js';
import type { Dispatcher } from '../agent/dispatcher.js';
import { DispatchQueueStatus } from '../queue/job-queue.js';
import { sendLocalCancel } from './cancel-run.js';

export const PeerCancelOutcome = z.enum([
  'delivered',
  'dequeued',
  'not-tracked',
  'agent-not-connected',
  'lookup-failed',
]);
export type PeerCancelOutcome = z.infer<typeof PeerCancelOutcome>;

/** A live dispatch row: the job and the agent it was handed to. */
export interface DispatchedAgent {
  jobId: string;
  agentId: string | null;
}

export interface PeerCancelDelivery extends DispatchedAgent {
  outcome: PeerCancelOutcome;
}

export interface PeerJobCancelDeps {
  dispatcher: Pick<Dispatcher, 'getAgentIdForJob' | 'getTrackedJobIdsForRun'>;
  registry: Pick<AgentRegistry, 'get'>;
  /** The durable dispatch record. Absent on a worker, which has no database. */
  lookupDispatched?: (runId: string, jobId: string | undefined) => Promise<DispatchedAgent[]>;
  /**
   * Remove this process's queued (not yet dispatched) jobs of the cancel, and
   * stop-mark its dispatched ones so a requeue cannot bring them back. Wired only
   * on a worker, whose queue lives in memory; a coordinator's queue rows are
   * settled by its own run-cancel path.
   */
  releaseQueued?: (runId: string, jobId: string | undefined) => Promise<string[]>;
  logger: {
    info(message: string, meta?: object): unknown;
    warn(message: string, meta?: object): unknown;
  };
}

const NOT_DELIVERED = 'Peer job cancel not delivered';

/** Read the live dispatch rows of a run, or of one job of it. */
export async function readDispatchedAgents(
  db: Kysely<Database>,
  runId: string,
  jobId: string | undefined,
): Promise<DispatchedAgent[]> {
  let query = db
    .selectFrom('dispatch_queue')
    .select(['id', 'agent_id'])
    .where('run_id', '=', runId)
    .where('status', 'in', [DispatchQueueStatus.Dispatched, DispatchQueueStatus.Recovering]);
  if (jobId !== undefined) query = query.where('id', '=', jobId);
  const rows = await query.execute();
  return rows.map((r) => ({ jobId: r.id, agentId: r.agent_id ?? null }));
}

/**
 * Deliver a `peer.job.cancel` to the agents connected here. Resolves; never
 * rejects: every failure is an outcome and a warn line.
 */
export async function deliverPeerJobCancel(
  deps: PeerJobCancelDeps,
  msg: PeerJobCancel,
): Promise<PeerCancelDelivery[]> {
  // First, before any lookup: the release stop-marks synchronously, so a requeue
  // racing this cancel drops the job instead of re-pending it.
  const dequeued = (await releaseQueued(deps, msg)).map((jobId): PeerCancelDelivery => ({
    jobId,
    agentId: null,
    outcome: PeerCancelOutcome.enum.dequeued,
  }));
  const targets = await resolveTargets(deps, msg);
  if (targets === PeerCancelOutcome.enum['lookup-failed']) {
    if (msg.jobId === undefined || dequeued.length > 0) return dequeued;
    return [{ jobId: msg.jobId, agentId: null, outcome: PeerCancelOutcome.enum['lookup-failed'] }];
  }
  if (targets.length === 0 && dequeued.length > 0) return dequeued;
  if (targets.length === 0) {
    deps.logger.warn(NOT_DELIVERED, {
      runId: msg.runId,
      ...(msg.jobId !== undefined && { jobId: msg.jobId }),
      outcome: PeerCancelOutcome.enum['not-tracked'],
    });
    return msg.jobId === undefined
      ? []
      : [{ jobId: msg.jobId, agentId: null, outcome: PeerCancelOutcome.enum['not-tracked'] }];
  }

  const deliveries: PeerCancelDelivery[] = [];
  for (const { jobId, agentId } of targets) {
    const delivery = deliverOne(deps, msg, jobId, agentId);
    if (delivery.outcome !== PeerCancelOutcome.enum.delivered) {
      deps.logger.warn(NOT_DELIVERED, {
        runId: msg.runId,
        jobId,
        agentId,
        outcome: delivery.outcome,
      });
    }
    deliveries.push(delivery);
  }
  const delivered = deliveries.filter((d) => d.outcome === PeerCancelOutcome.enum.delivered).length;
  if (delivered > 0) {
    deps.logger.info('Peer job cancel delivered', {
      runId: msg.runId,
      delivered,
      force: msg.force === true,
    });
  }
  return [...deliveries, ...dequeued];
}

/**
 * Run the worker's queued-job release, when wired. Resolves; never rejects: a
 * failed release is a warn line, and the cancel still reaches dispatched jobs.
 */
async function releaseQueued(deps: PeerJobCancelDeps, msg: PeerJobCancel): Promise<string[]> {
  if (!deps.releaseQueued) return [];
  let released: string[];
  try {
    released = await deps.releaseQueued(msg.runId, msg.jobId);
  } catch (err) {
    deps.logger.warn(NOT_DELIVERED, {
      runId: msg.runId,
      ...(msg.jobId !== undefined && { jobId: msg.jobId }),
      outcome: PeerCancelOutcome.enum['lookup-failed'],
      error: toErrorMessage(err),
    });
    return [];
  }
  if (released.length > 0) {
    deps.logger.info('Peer job cancel removed a queued job', {
      runId: msg.runId,
      ...(msg.jobId !== undefined && { jobId: msg.jobId }),
      removed: released.length,
    });
  }
  return released;
}

/** The jobs this cancel targets, with the agent each is known to run on. */
async function resolveTargets(
  deps: PeerJobCancelDeps,
  msg: PeerJobCancel,
): Promise<DispatchedAgent[] | (typeof PeerCancelOutcome.enum)['lookup-failed']> {
  if (msg.jobId !== undefined) {
    const mapped = deps.dispatcher.getAgentIdForJob(msg.jobId);
    if (mapped !== null) return [{ jobId: msg.jobId, agentId: mapped }];
  }
  if (deps.lookupDispatched) {
    try {
      return await deps.lookupDispatched(msg.runId, msg.jobId);
    } catch (err) {
      deps.logger.warn(NOT_DELIVERED, {
        runId: msg.runId,
        ...(msg.jobId !== undefined && { jobId: msg.jobId }),
        outcome: PeerCancelOutcome.enum['lookup-failed'],
        error: toErrorMessage(err),
      });
      return PeerCancelOutcome.enum['lookup-failed'];
    }
  }
  if (msg.jobId !== undefined) return [];
  return deps.dispatcher
    .getTrackedJobIdsForRun(msg.runId)
    .map((jobId) => ({ jobId, agentId: deps.dispatcher.getAgentIdForJob(jobId) }));
}

/**
 * Send one job's cancel to its agent. A known agent whose socket here is not
 * open reports `agent-not-connected` without a database read; the
 * stuck-cancelling sweep re-drives the cancel once the agent is back.
 */
function deliverOne(
  deps: PeerJobCancelDeps,
  msg: PeerJobCancel,
  jobId: string,
  agentId: string | null,
): PeerCancelDelivery {
  if (agentId === null) return { jobId, agentId, outcome: PeerCancelOutcome.enum['not-tracked'] };
  const sent = sendLocalCancel({
    registry: deps.registry,
    runId: msg.runId,
    jobId,
    agentId,
    reason: msg.reason,
    force: msg.force ?? false,
  });
  return {
    jobId,
    agentId,
    outcome: sent
      ? PeerCancelOutcome.enum.delivered
      : PeerCancelOutcome.enum['agent-not-connected'],
  };
}
