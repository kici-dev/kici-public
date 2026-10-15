/**
 * The single "cancel this whole run, recording a reason" path, shared by the
 * `POST /api/v1/admin/runs/:runId/cancel` route (`kici cancel`) and the
 * WorkflowDeadlineDetector (TimeoutReason.workflow_timeout), so both follow
 * identical mechanics.
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
import type { HeldRun } from '../db/types.js';
import { HeldRunStatus } from '../contexts/held-runs.js';
import {
  cancelHeldRunWithReason,
  HeldRunWithdrawal,
  type HeldRunDecidedFirst,
  type RejectHeldWorkflowOptions,
} from './cancel-held-run.js';

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
   * Forward `job.cancel` to the coordinator holding the agent's socket; returns
   * whether the send left this process. Undefined ⇒ no peer transport, so a
   * job owned by a sibling is unreachable rather than orphaned.
   */
  cancelJobOnPeer?: (
    peerId: string,
    runId: string,
    jobId: string,
    reason: string,
    force?: boolean,
  ) => boolean;
  /** How stale a `cluster_instances` heartbeat may be and still read as live. */
  ownershipGraceMs?: number;
  /**
   * `rejectWorkflow` bound to the live processing deps, so a cancel of a `held`
   * run withdraws its approval request. Undefined where no provider wiring
   * exists; the held run is then still cancelled and its holds rejected.
   */
  rejectHeldWorkflow?: (
    hold: HeldRun,
    reason: string,
    opts?: RejectHeldWorkflowOptions,
  ) => Promise<boolean>;
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
   * Jobs whose owning coordinator is alive but unreachable (peer send failed,
   * or no peer transport). Not notified and NOT orphaned: the job may still be
   * running, so the run stays `cancelling` and the re-drive sweep retries.
   */
  unreachable: number;
  /** Number of pending/queued execution_jobs rows marked cancelled. */
  pendingCancelled: number;
  /** The run was already terminal: a no-op, nothing notified or written. */
  alreadyTerminal: boolean;
  /**
   * The run was `held` and an approve, reject or expiry reached its holds
   * first, so the cancel wrote nothing. Entry points refuse it with
   * {@link heldRunCancelRefusal}.
   */
  decidedBeforeCancel?: HeldRunDecidedFirst;
}

/** Why a cancel of a held run whose hold an approve already released is refused. */
export const RUN_RESUMING_AFTER_APPROVAL_MESSAGE =
  'Run is resuming after approval; cancel it again once it is running';

/** Why a cancel of a held run whose hold a reject already decided is refused. */
export const RUN_REJECTED_BEFORE_CANCEL_MESSAGE =
  'Run was rejected before the cancel reached it; the rejection ends it';

/** Why a cancel of a held run whose hold already expired is refused. */
export const RUN_EXPIRED_BEFORE_CANCEL_MESSAGE =
  'Run approval request expired before the cancel reached it; the expiry ends it';

const REFUSAL_MESSAGES: Record<HeldRunDecidedFirst, string> = {
  [HeldRunWithdrawal.Approved]: RUN_RESUMING_AFTER_APPROVAL_MESSAGE,
  [HeldRunWithdrawal.Rejected]: RUN_REJECTED_BEFORE_CANCEL_MESSAGE,
  [HeldRunWithdrawal.Expired]: RUN_EXPIRED_BEFORE_CANCEL_MESSAGE,
};

/** The message a refused cancel of a held run answers with, naming the decision that won. */
export function heldRunCancelRefusal(decision: HeldRunDecidedFirst): string {
  return REFUSAL_MESSAGES[decision];
}

/**
 * Thrown by an entry point that refuses a cancel because a decision reached
 * the held run first. An expected race, not a failure: callers answer it as a
 * refusal rather than logging an error.
 */
export class HeldRunCancelRefusedError extends Error {
  constructor(readonly decision: HeldRunDecidedFirst) {
    super(heldRunCancelRefusal(decision));
    this.name = 'HeldRunCancelRefusedError';
  }
}

/**
 * Cancel a whole run, recording `reason` on its cancelled jobs and (if not
 * already set) on the run's failure_reason: sends `job.cancel` to every agent
 * holding a dispatched job, cancels queued dispatch rows, marks pending/queued
 * jobs cancelled. When no agent had outstanding work, drives the run terminal
 * immediately so it does not linger in `cancelling`.
 *
 * An already-terminal run is a no-op returning `alreadyTerminal: true`; the
 * operator route answers 409, the dashboard/MCP path a structured result.
 */
export async function cancelRunWithReason(
  deps: CancelRunDeps,
  runId: string,
  reason: string,
  options: CancelRunOptions = {},
): Promise<CancelRunResult> {
  const { db, jobQueue, registry, executionTracker } = deps;
  const force = options.force ?? false;

  // A cancel racing a finished run must not overwrite its terminal status,
  // completed_at, attribution or failure_reason: nothing else preserves them.
  // A missing row does NOT short-circuit — every entry point answers 404 first,
  // and the status-guarded UPDATEs below no-op on it.
  const runRow = await db
    .selectFrom('execution_runs')
    .select(['status'])
    .where('run_id', '=', runId)
    .executeTakeFirst();
  if (runRow && TERMINAL_RUN_STATES.has(runRow.status)) {
    logger.info('Cancel ignored: run already terminal', { runId, status: runRow.status });
    return { agentsNotified: 0, unreachable: 0, pendingCancelled: 0, alreadyTerminal: true };
  }

  // A held run has no job, only an approval request, which a cancel withdraws
  // like a reject. When a decision reached the holds first, the cancel writes
  // nothing and reports that decision: an approve leaves the run resuming, a
  // reject or an expiry ends it on its own.
  if (runRow?.status === ExecutionRunStatus.enum.held) {
    const withdrawal = await cancelHeldRunWithReason(
      { db, executionTracker, rejectHeldWorkflow: deps.rejectHeldWorkflow },
      runId,
      reason,
    );
    // fails-when: a cancel that lost to a decision stamps attribution and reports success
    // breaks-if-wrong: a withdrawn held run must still be cancelled and attributed
    if (withdrawal !== HeldRunWithdrawal.Withdrawn) {
      logger.info('Cancel refused: a decision reached the held run first', {
        runId,
        decision: withdrawal,
      });
      return {
        agentsNotified: 0,
        unreachable: 0,
        pendingCancelled: 0,
        alreadyTerminal: false,
        decidedBeforeCancel: withdrawal,
      };
    }
    await stampWithdrawnAttribution(db, runId, options);
    logger.info('Cancelled held run', { runId });
    return { agentsNotified: 0, unreachable: 0, pendingCancelled: 0, alreadyTerminal: false };
  }

  // A non-`held` run can still carry an open approval request: a dispatch-time
  // hold (a workflow `approval` block, a context reviewer) keeps it
  // `pending`/`running` with a placeholder job. A later approve would still
  // release it, so every pending hold is withdrawn first.
  await withdrawPendingHoldsOfActiveRun(deps, runId, reason);

  // Ownership is resolved from the DATABASE, not this process's `jobToAgent`
  // map: the Platform routes `run.cancel.request` by routing key and
  // `requestByRoutingKey` picks any connected pool member, so this coordinator
  // owns the jobs only by chance. A per-process map made sibling-dispatched
  // jobs look orphaned, and the orphan branch reported a cancel while the run
  // completed on the other coordinator.
  const dispatchedJobs = await jobQueue.getDispatchedJobOwnersByRunId(runId);
  const ownership = await resolveJobOwners(deps, dispatchedJobs);
  let agentsNotified = 0;
  let unreachable = 0;
  // Jobs still unwinding (cancel delivered, or owner alive and the forward will
  // be retried); the `pending`/`queued` sweep below must not mark them terminal.
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
    // Only the live sibling holding the agent's socket can deliver it, over the
    // existing `peer.job.cancel` wire message.
    const sent = deps.cancelJobOnPeer?.(ownerInstanceId!, runId, jobId, reason, force) ?? false;
    if (sent) {
      agentsNotified++;
      stillUnwinding.add(jobId);
      continue;
    }
    // Owner alive, forward failed: the job is very likely still running, so it
    // counts as unreachable, not orphaned. The run stays `cancelling` (a legal
    // non-terminal status) and the re-drive sweep retries.
    unreachable++;
    stillUnwinding.add(jobId);
    logger.warn('Cancel could not reach the coordinator that owns this job', {
      runId,
      jobId,
      ownerInstanceId,
    });
  }

  // Cancel the execution_jobs rows still waiting in the queue.
  //
  // A job an agent already holds can also read `pending`/`queued` (the row turns
  // `running` only on the agent's first frame). It is unwinding: it runs its
  // onCancel/cleanup hooks and reports its own terminal status. Writing
  // `cancelled` for it would, as `execution_jobs` writes are monotonic, reject
  // the agent's terminal frame, so the run-completion fan-out never fires and
  // the run never leaves `running`. Same reasoning as the `unreachable > 0`
  // suppression on the orphan sweep below.
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

  await jobQueue.cancelByRunId(runId);

  // Both writes are status-guarded so a cancel losing the race against the run
  // finishing writes nothing (the status read above narrows the window, these
  // predicates close it). failure_reason is also clobber-guarded so a more
  // specific cause already recorded wins.
  await stampCancelAttribution(db, runId, options);
  await db
    .updateTable('execution_runs')
    .set({ failure_reason: reason })
    .where('run_id', '=', runId)
    .where('failure_reason', 'is', null)
    .where('status', 'not in', [...TERMINAL_RUN_STATES])
    .execute();
  await stampForce(db, runId, force);

  // A cancel that reached no live owner must leave a durable trace: no agent
  // reports `cancelling` for a cancel that never arrived, and
  // `sweepStuckCancelling` selects on `cancelling`, so without this stamp the
  // re-drive never happens. Same guard as the agent-reported transition (a run
  // that finished meanwhile is untouched); `cancelling_at` starts the sweep's
  // clock.
  if (unreachable > 0) {
    await db
      .updateTable('execution_runs')
      .set({ status: ExecutionRunStatus.enum.cancelling, cancelling_at: new Date() })
      .where('run_id', '=', runId)
      .where('status', 'in', [ExecutionRunStatus.enum.running, ExecutionRunStatus.enum.pending])
      .execute();
  }

  // No agent had outstanding work, so no later job.complete will drive the run
  // terminal: finish it now. A `dispatched`/`running` row whose agent has no
  // live WS (never connected, died, or not yet acked — e.g. a workflow timeout
  // ~1s after dispatch) is orphaned: no `job.complete` ever comes, and the
  // WorkflowDeadlineDetector would re-fire forever. Cancel every non-terminal
  // job row so completeRunIfAllJobsTerminal can finish.
  //
  // `unreachable > 0` suppresses it: a job whose owner is alive but momentarily
  // unreachable is still running, not orphaned.
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
    // A run with no job rows is left in its status by the job-driven completion
    // above, so the cancel writes its terminal row itself rather than answering
    // "cancelled" over a `pending` row. A run with jobs is untouched.
    await executionTracker.cancelJoblessRun(runId, reason);
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

/**
 * Reject every pending approval request of a run that is not `held`, the way a
 * cancel of a held run does. The run itself is left to the job cancellation
 * that follows: the hold rejection's own terminal write only moves a `held`
 * run, so the placeholder and any running job still drive the run terminal.
 */
async function withdrawPendingHoldsOfActiveRun(
  deps: CancelRunDeps,
  runId: string,
  reason: string,
): Promise<void> {
  const pendingHold = await deps.db
    .selectFrom('held_runs')
    .select(['id'])
    .where('run_id', '=', runId)
    .where('status', '=', HeldRunStatus.Pending)
    .execute();
  // fails-when: a cancel of a running run with a dispatch-time hold leaves the hold pending
  // breaks-if-wrong: a run with no hold must take the plain job cancellation untouched
  if (pendingHold.length === 0) return;
  // The withdrawal settles the holds and their checks and writes no run row.
  // Losing to a decision is deliberately not refused, unlike the held-run
  // branch: an approve re-dispatches onto an already-live run, and the job path
  // cancels that work like every other job of the run.
  const withdrawal = await cancelHeldRunWithReason(
    {
      db: deps.db,
      executionTracker: deps.executionTracker,
      rejectHeldWorkflow: deps.rejectHeldWorkflow,
    },
    runId,
    reason,
    { terminalWrite: false },
  );
  logger.info('Withdrew the pending approval requests of a cancelled run', {
    runId,
    withdrawn: withdrawal === HeldRunWithdrawal.Withdrawn,
    ...(withdrawal !== HeldRunWithdrawal.Withdrawn && { decision: withdrawal }),
  });
}

/**
 * Record a forced cancel on a non-terminal run, so the stuck-cancelling sweep
 * re-sends with `force`. Only ever set: a later graceful cancel does not turn
 * a forced one graceful.
 */
async function stampForce(db: Kysely<Database>, runId: string, force: boolean): Promise<void> {
  if (!force) return;
  await db
    .updateTable('execution_runs')
    .set({ cancel_force: true })
    .where('run_id', '=', runId)
    .where('status', 'not in', [...TERMINAL_RUN_STATES])
    .execute();
}

/** Record who cancelled the run, while it is still non-terminal. */
async function stampCancelAttribution(
  db: Kysely<Database>,
  runId: string,
  options: CancelRunOptions,
): Promise<void> {
  if (!options.cancelledBy) return;
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

/**
 * Record who cancelled a held run the cancel just withdrew. The run is already
 * `cancelled` here, so the non-terminal guard of {@link stampCancelAttribution}
 * would skip it; this one is guarded on the cancelled row carrying no attribution.
 */
async function stampWithdrawnAttribution(
  db: Kysely<Database>,
  runId: string,
  options: CancelRunOptions,
): Promise<void> {
  if (!options.cancelledBy) return;
  await db
    .updateTable('execution_runs')
    .set({
      cancelled_by: options.cancelledBy,
      ...(options.cancelledByAgentLabel != null && {
        cancelled_by_agent_label: options.cancelledByAgentLabel,
      }),
    })
    .where('run_id', '=', runId)
    .where('status', '=', ExecutionRunStatus.enum.cancelled)
    .where('cancelled_by', 'is', null)
    .execute();
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
 * Resolve which coordinator can deliver each dispatched job's `job.cancel`.
 * `host_roster`'s `connected_instance_id` wins over the row's
 * `owner_instance_id`, since an agent that reconnected elsewhere since dispatch
 * is reachable only there; the dispatch record is the fallback.
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
 * Send `job.cancel` down this coordinator's own socket for the agent. A
 * mid-close socket stays registered until its close handler runs and throws on
 * send, so a non-OPEN socket leaves the job to the orphan sweep. The send is
 * wrapped so one bad socket cannot strand the run in `cancelling`.
 */
export function sendLocalCancel(args: {
  registry: Pick<AgentRegistry, 'get'>;
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
