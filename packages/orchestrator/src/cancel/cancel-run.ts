/**
 * Shared run-cancellation path.
 *
 * `cancelRunWithReason` is the single canonical implementation of "cancel
 * this whole run, recording a reason". It is invoked by:
 *
 *  - the operator-facing `POST /api/v1/admin/runs/:runId/cancel` route
 *    (user-initiated `kici cancel`), and
 *  - the WorkflowDeadlineDetector, which cancels runs that exceeded their
 *    workflow-level wall-clock timeout (TimeoutReason.workflow_timeout).
 *
 * Keeping one implementation means the deadline enforcer and the user cancel
 * follow identical mechanics: send `job.cancel` to the agents running the
 * run's jobs, cancel queued dispatch rows, mark pending/queued jobs cancelled,
 * stamp the failure reason, and drive the run terminal when no agent work is
 * outstanding.
 */

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { createLogger } from '@kici-dev/shared';
import {
  ExecutionJobStatus,
  ExecutionRunStatus,
  TERMINAL_JOB_STATES,
  TERMINAL_RUN_STATES,
} from '@kici-dev/engine';
import type { Database } from '../db/types.js';
import type { JobQueue } from '../queue/job-queue.js';
import {
  DEFAULT_RECOVERY_GRACE_MS,
  instanceLivenessGraceMs,
  liveInstanceIds,
} from '../cluster/instance-heartbeat.js';
import type { AgentRegistry } from '../agent/registry.js';
import type { ExecutionTracker } from '../reporting/execution-tracker.js';

const logger = createLogger({ prefix: 'cancel-run' });

export interface CancelRunDeps {
  db: Kysely<Database>;
  jobQueue: JobQueue;
  registry: AgentRegistry;
  executionTracker: ExecutionTracker;
  /**
   * This coordinator's instance id. Undefined ⇒ no cluster identity, so every
   * job resolves to "mine" and the behaviour is the single-coordinator one.
   */
  instanceId?: string;
  /**
   * Forward `job.cancel` to the coordinator holding the agent's socket.
   * Returns whether the send left this process. Undefined ⇒ no peer transport,
   * so a job owned by a sibling is unreachable rather than orphaned.
   */
  cancelJobOnPeer?: (peerId: string, runId: string, jobId: string, reason: string) => boolean;
  /** How stale a `cluster_instances` heartbeat may be and still read as live. */
  ownershipGraceMs?: number;
}

export interface CancelRunOptions {
  /** Force immediate SIGKILL on the agent (skip graceful hooks). */
  force?: boolean;
  /** Attribution stamped into execution_runs.cancelled_by. */
  cancelledBy?: string;
  /** Agent provenance label stamped into execution_runs.cancelled_by_agent_label. */
  cancelledByAgentLabel?: string | null;
}

export interface CancelRunResult {
  /** Number of `job.cancel` messages dispatched to agents (running jobs). */
  agentsNotified: number;
  /**
   * Jobs whose owning coordinator is alive but could not be reached — the peer
   * send failed, or there is no peer transport. They are NOT notified and they
   * are NOT orphaned: the job may well still be running, so the run stays
   * `cancelling` and the re-drive sweep tries again.
   */
  unreachable: number;
  /** Number of pending/queued execution_jobs rows marked cancelled. */
  pendingCancelled: number;
  /**
   * True when the run was already in a terminal status, so the cancel was a
   * no-op: no agent was notified and no row was written.
   */
  alreadyTerminal: boolean;
}

/**
 * Cancel a whole run, recording `reason` on its cancelled jobs and (if not
 * already set) on the run's failure_reason. Sends `job.cancel` to every agent
 * holding a dispatched job for the run; cancels queued dispatch rows; marks
 * pending/queued jobs cancelled. When no agent had outstanding work, drives
 * the run to its terminal status immediately so the run does not linger in
 * `cancelling`.
 *
 * A cancel targeting a run that is already terminal is a no-op: the run's
 * status is read first and, when terminal, the function returns
 * `alreadyTerminal: true` having written nothing. Entry points map that to
 * their own convention (the operator route answers 409; the dashboard/MCP path
 * returns a structured already-terminal result).
 */
export async function cancelRunWithReason(
  deps: CancelRunDeps,
  runId: string,
  reason: string,
  options: CancelRunOptions = {},
): Promise<CancelRunResult> {
  const { db, jobQueue, registry, executionTracker } = deps;
  const force = options.force ?? false;

  // A cancel racing a run that already finished must not touch the finished
  // record: overwriting a terminal status, completed_at, attribution or
  // failure_reason destroys a historical result that nothing else preserves.
  // A missing row does NOT short-circuit — every entry point answers 404 before
  // reaching here, and the status-guarded UPDATEs below no-op on a row that
  // does not exist.
  const runRow = await db
    .selectFrom('execution_runs')
    .select(['status'])
    .where('run_id', '=', runId)
    .executeTakeFirst();
  if (runRow && TERMINAL_RUN_STATES.has(runRow.status)) {
    logger.info('Cancel ignored: run already terminal', { runId, status: runRow.status });
    return { agentsNotified: 0, unreachable: 0, pendingCancelled: 0, alreadyTerminal: true };
  }

  // Notify the agents running this run's jobs so in-flight work unwinds
  // (graceful hooks unless force).
  //
  // Ownership is resolved from the DATABASE, not from this process's
  // `jobToAgent` map. The coordinator handling a cancel is the owner only by
  // chance: the Platform routes `run.cancel.request` by routing key and
  // `requestByRoutingKey` picks any connected pool member. Resolving through a
  // per-process map made every job a sibling dispatched look orphaned, so the
  // orphan branch below marked the run cancelled and told the operator the
  // deploy had stopped while it ran to completion on the other coordinator.
  const dispatchedJobs = await jobQueue.getDispatchedJobOwnersByRunId(runId);
  const ownership = await resolveJobOwners(deps, dispatchedJobs);
  let agentsNotified = 0;
  let unreachable = 0;
  // Jobs an agent is still unwinding: the cancel reached it, or its owner is
  // alive and the forward will be retried. Neither has finished, so neither may
  // be recorded terminal below — see the `pending`/`queued` sweep.
  const stillUnwinding = new Set<string>();
  for (const { jobId, agentId, ownerInstanceId, ownerIsSelf, ownerIsLive } of ownership) {
    if (ownerIsSelf) {
      if (sendLocalCancel({ registry, runId, jobId, agentId, reason, force })) {
        agentsNotified++;
        stillUnwinding.add(jobId);
      }
      continue;
    }
    if (!ownerIsLive) continue; // Genuinely orphaned — the orphan branch owns it.
    // A live sibling holds the agent's socket, and only that coordinator can
    // put a `job.cancel` frame on it. `peer.job.cancel` already exists on the
    // wire, so this adds no protocol surface.
    const sent = deps.cancelJobOnPeer?.(ownerInstanceId!, runId, jobId, reason) ?? false;
    if (sent) {
      agentsNotified++;
      stillUnwinding.add(jobId);
      continue;
    }
    // The owner is alive but the forward did not leave this process. The job is
    // very likely still running, so counting it as orphaned would mark the run
    // cancelled while it executes. Count it unreachable instead: the run stays
    // `cancelling` (a legal non-terminal status) and the re-drive sweep retries.
    unreachable++;
    stillUnwinding.add(jobId);
    logger.warn('Cancel could not reach the coordinator that owns this job', {
      runId,
      jobId,
      ownerInstanceId,
    });
  }

  // Cancel the execution_jobs rows nobody is working: the ones still waiting in
  // the queue.
  //
  // A job an agent already holds also reads `pending`/`queued` here — the row
  // only becomes `running` when the agent reports its first frame, and a
  // dispatch that beat that frame leaves it queued. Such a job is not waiting,
  // it is unwinding: it runs its onCancel/cleanup hooks and then reports its own
  // terminal status. Writing `cancelled` for it records a terminal verdict for
  // work still in flight, and — because `execution_jobs` writes are monotonic —
  // makes the agent's own terminal frame a rejected write, so the run-completion
  // fan-out that frame drives never fires and the run never leaves `running`.
  // Same reasoning as the `unreachable > 0` suppression on the orphan sweep
  // below, applied one step earlier.
  let pendingQuery = db
    .updateTable('execution_jobs')
    .set({
      status: ExecutionJobStatus.enum.cancelled,
      completed_at: new Date(),
      error_message: reason,
      // Leaving the queue: the routing reason no longer describes anything.
      routing_reason: null,
    })
    .where('run_id', '=', runId)
    .where('status', 'in', [ExecutionJobStatus.enum.pending, ExecutionJobStatus.enum.queued]);
  if (stillUnwinding.size > 0) {
    pendingQuery = pendingQuery.where('job_id', 'not in', [...stillUnwinding]);
  }
  const pendingResult = await pendingQuery.execute();
  const pendingCancelled = Number(pendingResult[0]?.numUpdatedRows ?? 0);

  // Cancel queued dispatch_queue entries for the run.
  await jobQueue.cancelByRunId(runId);

  // Stamp attribution + the cancellation reason. Both writes are status-guarded
  // so a cancel that loses the race against the run finishing writes nothing —
  // the status read above narrows the window, these predicates close it.
  // failure_reason is additionally clobber-guarded so a more specific cause
  // already recorded wins.
  if (options.cancelledBy) {
    await db
      .updateTable('execution_runs')
      .set({
        cancelled_by: options.cancelledBy,
        ...(options.cancelledByAgentLabel != null && {
          cancelled_by_agent_label: options.cancelledByAgentLabel,
        }),
      })
      .where('run_id', '=', runId)
      .where('status', 'not in', [...TERMINAL_RUN_STATES])
      .execute();
  }
  await db
    .updateTable('execution_runs')
    .set({ failure_reason: reason })
    .where('run_id', '=', runId)
    .where('failure_reason', 'is', null)
    .where('status', 'not in', [...TERMINAL_RUN_STATES])
    .execute();

  // A cancel that reached no live owner has to leave a durable trace, or it is
  // dropped in silence. Nothing else records it: no agent reports `cancelling`
  // for a job whose cancel never arrived, so the run stays `running`, and
  // `sweepStuckCancelling` selects on `cancelling` and never sees it. Stamping
  // the status here is what makes the re-drive real rather than nominal. Same
  // guard as the agent-reported transition, so a run that finished in the
  // meantime is untouched, and `cancelling_at` starts the sweep's clock.
  if (unreachable > 0) {
    await db
      .updateTable('execution_runs')
      .set({ status: ExecutionRunStatus.enum.cancelling, cancelling_at: new Date() })
      .where('run_id', '=', runId)
      .where('status', 'in', [ExecutionRunStatus.enum.running, ExecutionRunStatus.enum.pending])
      .execute();
  }

  // When no agent had outstanding work, the run won't get a later job.complete
  // to drive it terminal — finish it now from current job state. But a job can
  // be `dispatched`/`running` in execution_jobs while its agent has no live WS
  // (it never connected, died, or hasn't acked the dispatch yet — e.g. a
  // workflow timeout that fires within ~1s of dispatch, before the freshly
  // spawned agent connects). Such a row is orphaned: no agent will ever send
  // its `job.complete`, so the run can never complete and a periodic canceller
  // (the WorkflowDeadlineDetector) would re-fire forever. Cancel every
  // remaining non-terminal job row so completeRunIfAllJobsTerminal can finish.
  //
  // `unreachable > 0` suppresses it: a job whose owner is alive but momentarily
  // unreachable is not an orphan, and cancelling it here would record a
  // terminal verdict for work that is still running.
  let orphansCancelled = 0;
  if (agentsNotified === 0 && unreachable === 0) {
    const orphanResult = await db
      .updateTable('execution_jobs')
      .set({
        status: ExecutionJobStatus.enum.cancelled,
        completed_at: new Date(),
        error_message: reason,
      })
      .where('run_id', '=', runId)
      .where('status', 'not in', [...TERMINAL_JOB_STATES])
      .execute();
    orphansCancelled = Number(orphanResult[0]?.numUpdatedRows ?? 0);
    await executionTracker.completeRunIfAllJobsTerminal(runId);
  }

  logger.info('Cancelled run', {
    runId,
    agentsNotified,
    unreachable,
    pendingCancelled,
    orphansCancelled,
    force,
  });
  return { agentsNotified, unreachable, pendingCancelled, alreadyTerminal: false };
}

/** One dispatched job, with the cancel routing decision already made for it. */
interface JobOwnership {
  jobId: string;
  agentId: string | null;
  ownerInstanceId: string | null;
  ownerIsSelf: boolean;
  ownerIsLive: boolean;
}

/**
 * Resolve, for each dispatched job, which coordinator can actually deliver its
 * `job.cancel`.
 *
 * The agent's CURRENT connection is what matters, so `host_roster`'s
 * `connected_instance_id` wins over the row's `owner_instance_id`: an agent that
 * reconnected to a different coordinator since dispatch is reachable only
 * there. The dispatch record is the fallback for an agent with no roster row.
 */
async function resolveJobOwners(
  deps: CancelRunDeps,
  jobs: Array<{ jobId: string; agentId: string | null; ownerInstanceId: string | null }>,
): Promise<JobOwnership[]> {
  const { db, registry, instanceId } = deps;
  const agentIds = jobs.map((j) => j.agentId).filter((a): a is string => a !== null);
  const rosterOwners = new Map<string, string | null>();
  if (agentIds.length > 0) {
    const rows = await db
      .selectFrom('host_roster')
      .select(['agent_id', 'connected_instance_id'])
      .where('agent_id', 'in', [...new Set(agentIds)])
      .execute();
    for (const row of rows) rosterOwners.set(row.agent_id, row.connected_instance_id);
  }

  const resolved = jobs.map((job) => {
    const rosterOwner = job.agentId === null ? undefined : rosterOwners.get(job.agentId);
    const owner = rosterOwner ?? job.ownerInstanceId;
    // An agent this process has a live registration for is ours whatever the
    // roster says — the roster is a best-effort stamp and can lag a reconnect.
    const locallyRegistered = job.agentId !== null && registry.get(job.agentId) !== undefined;
    const ownerIsSelf =
      locallyRegistered || owner === undefined || owner === null || owner === instanceId;
    return { ...job, ownerInstanceId: owner ?? null, ownerIsSelf, ownerIsLive: ownerIsSelf };
  });

  const siblingIds = resolved
    .filter((r) => !r.ownerIsSelf && r.ownerInstanceId !== null)
    .map((r) => r.ownerInstanceId as string);
  if (siblingIds.length === 0) return resolved;
  const live = await liveInstanceIds(
    db,
    siblingIds,
    deps.ownershipGraceMs ?? instanceLivenessGraceMs(DEFAULT_RECOVERY_GRACE_MS),
  );
  return resolved.map((r) =>
    r.ownerIsSelf
      ? r
      : { ...r, ownerIsLive: r.ownerInstanceId !== null && live.has(r.ownerInstanceId) },
  );
}

/**
 * Send `job.cancel` down this coordinator's own socket for the agent.
 *
 * Only an OPEN socket can receive it. A socket mid-close is still in the
 * registry until its close handler unregisters it, and sending to it throws, so
 * a non-OPEN socket leaves the job un-notified and the orphan sweep takes it.
 * The send is wrapped so one bad socket cannot abort the whole cancellation and
 * strand the run in `cancelling`.
 */
function sendLocalCancel(args: {
  registry: AgentRegistry;
  runId: string;
  jobId: string;
  agentId: string | null;
  reason: string;
  force: boolean;
}): boolean {
  const { registry, runId, jobId, agentId, reason, force } = args;
  if (agentId === null) return false;
  const entry = registry.get(agentId);
  if (entry?.ws?.readyState !== 1 /* OPEN */) return false;
  try {
    entry.ws.send(
      JSON.stringify({
        type: 'job.cancel' as const,
        messageId: randomUUID(),
        runId,
        jobId,
        reason,
        ...(force && { force: true }),
      }),
    );
    return true;
  } catch (err) {
    logger.warn('Failed to send job.cancel to agent; treating job as orphaned', {
      runId,
      jobId,
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
