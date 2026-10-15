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
 * The dispatch rows that have gone unacknowledged long enough to reap. Separate from the
 * detector so its raw-SQL predicates are asserted against a real Postgres, not a mock.
 *
 * - **Both bounds read the DISPATCH clock**, not the enqueue clock. `created_at` measures
 *   "enqueued long ago and not yet running", true of every job that waited behind a busy
 *   fleet: a job claimed after a scaler cold start would be reaped mid-clone with "dispatch
 *   never acknowledged" while the agent ran it to completion for nothing.
 * - **The COALESCE is the rolling-upgrade bridge.** A row dispatched before `dispatched_at`
 *   existed carries NULL and falls back to `created_at`. That also makes startup recovery's
 *   sparing of an unknown-owner row safe: a spared orphan is still reaped here.
 * - **An acked dispatch is never reaped.** A row with `ack_deadline` cleared and
 *   `ack_agent_id` stamped was acknowledged, and the ack path owns it. This scan covers the
 *   never-acked, crashed-coordinator case; the heartbeat sub-scans cover a job that acked and
 *   then went quiet.
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
      // Trust posture, so a job reaped on a fork run still explains its reduced privileges.
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
    // A running job belongs to the heartbeat scanners.
    .where((eb) =>
      eb.or([eb('ej.status', 'is', null), eb('ej.status', '!=', ExecutionJobStatus.enum.running)]),
    )
    .execute();
  return rows as StaleDispatchCandidate[];
}
