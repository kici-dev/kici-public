/**
 * Handler for the `dashboard.run.state` system reconciliation read.
 *
 * The Platform's `RunMirrorReconciler` sends it for a run stuck non-terminal in
 * the Platform mirror, to recover a terminal frame dropped on a live
 * connection. It projects `execution_runs` + `execution_jobs` for one run into
 * the `StateReplayRun` shape of the reconnect `state.replay` push, so the
 * Platform drives it through the shared `upsertRunMirror` helper. Pure (deps
 * passed as arguments), so the `server.ts` wiring stays a thin adapter and the
 * logic is unit-testable without a live Platform connection.
 *
 * Unlike `dashboard.run.detail`, it writes NO `access_log` row: it is a
 * `system`-actor reconciliation read, not a user data access.
 */
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import {
  clampStatusFreeText,
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
      'workflow_repo_identifier',
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
      'status_epoch',
    ])
    .where('run_id', '=', req.runId)
    .executeTakeFirst();

  if (!row) {
    return { type: 'dashboard.run.state.response', requestId: req.requestId, run: null };
  }

  const jobRows = await deps.db
    .selectFrom('execution_jobs')
    .select(['job_id', 'job_name', 'workflow_name', 'status'])
    .where('run_id', '=', req.runId)
    .execute();

  const jobs = jobRows.map((j) => ({
    jobId: j.job_id,
    jobName: j.job_name,
    ...(j.workflow_name && { workflowName: j.workflow_name }),
    status: j.status,
  }));

  const run: StateReplayRun = {
    runId: row.run_id,
    workflowName: row.workflow_name,
    status: row.status as ExecutionRunStatus,
    ...(row.routing_key && { routingKey: row.routing_key }),
    repoIdentifier: row.repo_identifier,
    // Set only for a cross-repository global run; dropping it would recover a
    // global run into the mirror as an ordinary per-repository one.
    ...(row.workflow_repo_identifier && {
      workflowRepoIdentifier: row.workflow_repo_identifier,
    }),
    sha: row.sha,
    ref: row.ref,
    parentRunId: row.parent_run_id,
    originalRunId: row.original_run_id,
    triggeredBy: row.triggered_by,
    triggeredByAgentLabel: row.triggered_by_agent_label,
    ...(row.failure_reason && { failureReason: clampStatusFreeText(row.failure_reason) }),
    ...(row.failure_class && { failureClass: row.failure_class as RunFailureClass }),
    jobCount: jobs.length,
    startedAt: row.started_at.getTime(),
    ...(row.completed_at && { completedAt: row.completed_at.getTime() }),
    ...(row.duration_ms !== null && { durationMs: row.duration_ms }),
    statusEpoch: row.status_epoch ?? 0,
    jobs,
  };

  return { type: 'dashboard.run.state.response', requestId: req.requestId, run };
}
