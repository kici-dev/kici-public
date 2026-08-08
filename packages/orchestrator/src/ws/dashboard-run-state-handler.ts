/**
 * Orchestrator-side handler for the `dashboard.run.state` system reconciliation
 * read.
 *
 * The Platform's `RunMirrorReconciler` issues this request for a run that is
 * stuck non-terminal in the Platform mirror to recover a terminal frame that was
 * dropped on a live Platform↔orchestrator connection. It projects the current
 * `execution_runs` + `execution_jobs` state for one run into the same
 * `StateReplayRun` shape the reconnect `state.replay` push carries, so the
 * Platform can drive it through the shared `upsertRunMirror` helper.
 *
 * Unlike the user-plane `dashboard.run.detail` read, this handler does NOT write
 * an `access_log` row: it is a system reconciliation read (a `system` actor),
 * not a user data access. The handler is pure (deps passed as arguments) so the
 * WS wiring in `server.ts` stays a thin adapter and the logic is unit-testable
 * without a live Platform connection.
 */
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import {
  ExecutionRunStatus,
  RunFailureClass,
  type DashboardRunStateRequest,
  type DashboardRunStateResponse,
  type StateReplayRun,
} from '@kici-dev/engine';

export interface RunStateHandlerDeps {
  db: Kysely<Database>;
}

/**
 * Build the `StateReplayRun` projection for one run, or `null` when the
 * orchestrator has no such run. Mirrors the DB-backed branch of
 * `ExecutionTracker.getReplayDataWithDb` (jobs = id/name/status;
 * `jobCount = jobs.length`; `triggerEvent`/`commitMessage` omitted — no columns).
 */
export async function handleRunState(
  deps: RunStateHandlerDeps,
  req: DashboardRunStateRequest,
): Promise<DashboardRunStateResponse> {
  const row = await deps.db
    .selectFrom('execution_runs')
    .select([
      'run_id',
      'workflow_name',
      'status',
      'routing_key',
      'repo_identifier',
      'sha',
      'ref',
      'started_at',
      'completed_at',
      'duration_ms',
      'parent_run_id',
      'original_run_id',
      'triggered_by',
      'triggered_by_agent_label',
      'failure_reason',
      'failure_class',
    ])
    .where('run_id', '=', req.runId)
    .executeTakeFirst();

  if (!row) {
    return { type: 'dashboard.run.state.response', requestId: req.requestId, run: null };
  }

  const jobRows = await deps.db
    .selectFrom('execution_jobs')
    .select(['job_id', 'job_name', 'status'])
    .where('run_id', '=', req.runId)
    .execute();

  const jobs = jobRows.map((j) => ({ jobId: j.job_id, jobName: j.job_name, status: j.status }));

  const run: StateReplayRun = {
    runId: row.run_id,
    workflowName: row.workflow_name,
    status: row.status as ExecutionRunStatus,
    ...(row.routing_key && { routingKey: row.routing_key }),
    repoIdentifier: row.repo_identifier,
    sha: row.sha,
    ref: row.ref,
    parentRunId: row.parent_run_id,
    originalRunId: row.original_run_id,
    triggeredBy: row.triggered_by,
    triggeredByAgentLabel: row.triggered_by_agent_label,
    ...(row.failure_reason && { failureReason: row.failure_reason }),
    ...(row.failure_class && { failureClass: row.failure_class as RunFailureClass }),
    jobCount: jobs.length,
    startedAt: row.started_at.getTime(),
    ...(row.completed_at && { completedAt: row.completed_at.getTime() }),
    ...(row.duration_ms !== null && { durationMs: row.duration_ms }),
    jobs,
  };

  return { type: 'dashboard.run.state.response', requestId: req.requestId, run };
}
