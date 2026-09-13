import { sql, type Kysely, type SqlBool } from 'kysely';
import { ExecutionJobStatus } from '@kici-dev/engine';
import type { Database } from '../db/types.js';
import { DispatchQueueStatus } from '../queue/job-queue.js';

/** One dispatch row the stale scan may reap, with the run facts its verdict needs. */
export interface StaleDispatchCandidate {
  id: string;
  run_id: string;
  job_name: string;
  status: string;
  workflow_name: string;
  repo_identifier: string;
  workflow_repo_identifier: string | null;
  trust_tier: string | null;
  lock_file_source: string | null;
  sha: string;
  provider: string;
  provider_context: string | null;
  routing_key: string | null;
}

/**
 * The dispatch rows that have gone unacknowledged long enough to reap.
 *
 * Split out of the detector so the three predicates that decide the verdict can
 * be asserted against a real Postgres — they are raw SQL, and a mock records
 * them without evaluating them.
 *
 * - **Both bounds read the DISPATCH clock**, not the enqueue clock.
 *   `created_at` is when the job was queued, so keying on it measured "enqueued
 *   more than two minutes ago and not yet reported running" — true of every job
 *   that waited behind a busy fleet. A job claimed at 3:00 after a scaler cold
 *   start, then cloning its repo and installing dependencies, was reaped at 3:30
 *   with "dispatch never acknowledged" while the agent ran it to completion for
 *   nothing.
 * - **The COALESCE is the rolling-upgrade bridge.** A row dispatched before
 *   `dispatched_at` existed carries NULL and keeps exactly the previous
 *   behaviour. That is also what makes startup recovery's decision to spare an
 *   unknown-owner row safe: a spared orphan is still reaped here.
 * - **An acked dispatch is never reaped.** A row whose `ack_deadline` was
 *   cleared while `ack_agent_id` is stamped was acknowledged, and the ack path
 *   owns it. This scan's residual job is the never-acked, crashed-coordinator
 *   case; the heartbeat sub-scans cover a job that acked and then went quiet.
 */
export async function selectStaleDispatchCandidates(
  db: Kysely<Database>,
  threshold: Date,
  timeBound: Date,
): Promise<StaleDispatchCandidate[]> {
  const rows = await db
    .selectFrom('dispatch_queue as dq')
    .innerJoin('execution_runs as er', (join) => join.onRef('er.run_id', '=', sql`dq.run_id::uuid`))
    .leftJoin('execution_jobs as ej', (join) =>
      join.onRef('ej.run_id', '=', sql`dq.run_id::uuid`).onRef('ej.job_name', '=', 'dq.job_name'),
    )
    .select([
      'dq.id',
      'dq.run_id',
      'dq.job_name',
      'dq.status',
      'er.workflow_name',
      'er.repo_identifier',
      'er.workflow_repo_identifier',
      // The run's trust posture, forwarded onto the check-run completion so a
      // job reaped on a fork run still explains its reduced privileges.
      'er.trust_tier',
      'er.lock_file_source',
      'er.sha',
      'er.provider',
      'er.provider_context',
      'er.routing_key',
    ])
    .where('dq.status', '=', DispatchQueueStatus.Dispatched)
    .where(sql<SqlBool>`COALESCE(dq.dispatched_at, dq.created_at) < ${threshold}`)
    .where(sql<SqlBool>`COALESCE(dq.dispatched_at, dq.created_at) > ${timeBound}`)
    .where(sql<SqlBool>`(dq.ack_deadline IS NOT NULL OR dq.ack_agent_id IS NULL)`)
    // Skip rows where the agent has already started running the job —
    // those are supervised by the heartbeat scanners.
    .where((eb) =>
      eb.or([eb('ej.status', 'is', null), eb('ej.status', '!=', ExecutionJobStatus.enum.running)]),
    )
    .execute();
  return rows as StaleDispatchCandidate[];
}
