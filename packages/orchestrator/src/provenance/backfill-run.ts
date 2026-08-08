/**
 * Replay the run/job rows the Platform missed while it was down, so a deferred
 * attestation's later mint has the `execution_runs` / `execution_jobs` rows it
 * derives identity claims from. This is NOT a new ingestion path: it re-sends
 * exactly the `execution.status` + `job.status.forward` messages the
 * orchestrator would have sent live (from the same org-asserted local rows), so
 * it concedes no more trust independence than the live path already does. The
 * offline-backfill marker on the attestation discloses the temporal gap.
 *
 * The retrier orders backfill BEFORE the mint for an `offline-backfill` row.
 */
import { randomUUID } from 'node:crypto';
import type { OrchestratorToPlatformMessage } from '@kici-dev/engine';

/** The local `execution_runs` fields the backfill needs (production reads via Kysely). */
export interface BackfillRunRow {
  run_id: string;
  workflow_name: string;
  status: string;
  routing_key: string | null;
  repo_identifier: string | null;
  provider: string | null;
  local_working_tree: boolean | null;
  sha: string | null;
  ref: string | null;
  job_count: number | null;
  started_at: Date | null;
  completed_at: Date | null;
  duration_ms: number | null;
}

/** The local `execution_jobs` fields the backfill needs. */
export interface BackfillJobRow {
  run_id: string;
  job_id: string;
  job_name: string;
  status: string;
  started_at: Date | null;
  completed_at: Date | null;
  agent_id: string | null;
  orchestrator_id: string | null;
}

export interface BackfillRunDeps {
  send: (message: OrchestratorToPlatformMessage) => void;
  loadRun: (runId: string) => Promise<BackfillRunRow | null>;
  loadJobs: (runId: string) => Promise<BackfillJobRow[]>;
}

const ms = (d: Date | null | undefined): number | undefined => (d ? d.getTime() : undefined);

/**
 * Send one `execution.status` (terminal) followed by one `job.status.forward`
 * per job, populating exactly the fields the Platform's `handler.ts` upserts.
 * Ordered execution.status FIRST so the run row exists before the job rows
 * reference it. A no-op (throws) when the run is not found locally — the caller
 * leaves the pending row `deferred` with a clear error.
 */
export async function backfillRunToPlatform(deps: BackfillRunDeps, runId: string): Promise<void> {
  const run = await deps.loadRun(runId);
  if (!run) {
    throw new Error(`cannot backfill run ${runId}: not found in local execution_runs`);
  }
  const now = Date.now();
  deps.send({
    type: 'execution.status',
    messageId: randomUUID(),
    runId: run.run_id,
    workflowName: run.workflow_name,
    status: run.status,
    ...(run.routing_key ? { routingKey: run.routing_key } : {}),
    ...(run.repo_identifier ? { repoIdentifier: run.repo_identifier } : {}),
    ...(run.provider ? { repoProvider: run.provider } : {}),
    ...(run.local_working_tree != null ? { localWorkingTree: run.local_working_tree } : {}),
    ...(run.sha ? { sha: run.sha } : {}),
    ...(run.ref ? { ref: run.ref } : {}),
    ...(run.job_count != null ? { jobCount: run.job_count } : {}),
    startedAt: ms(run.started_at) ?? now,
    ...(ms(run.completed_at) !== undefined ? { completedAt: ms(run.completed_at) } : {}),
    ...(run.duration_ms != null ? { durationMs: run.duration_ms } : {}),
    timestamp: now,
  } as unknown as OrchestratorToPlatformMessage);

  const jobs = await deps.loadJobs(runId);
  for (const job of jobs) {
    deps.send({
      type: 'job.status.forward',
      messageId: randomUUID(),
      runId: job.run_id,
      jobId: job.job_id,
      jobName: job.job_name,
      status: job.status,
      ...(ms(job.started_at) !== undefined ? { startedAt: ms(job.started_at) } : {}),
      ...(ms(job.completed_at) !== undefined ? { completedAt: ms(job.completed_at) } : {}),
      ...(job.agent_id ? { agentId: job.agent_id } : {}),
      ...(job.orchestrator_id ? { orchestratorId: job.orchestrator_id } : {}),
      timestamp: now,
    } as unknown as OrchestratorToPlatformMessage);
  }
}
