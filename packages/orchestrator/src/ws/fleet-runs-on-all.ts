/**
 * Resolve a workflow's `runsOnAll` host-fan-out predicate from the orchestrator's
 * persisted registrations, for the fleet runsOnAll-preview read path.
 * Reads the lock entry stored as JSON in `workflow_registrations.lock_entry`.
 */
import type { Kysely } from 'kysely';
import { isLockStaticJob, type LockWorkflow } from '@kici-dev/engine';
import type { Database } from '../db/types.js';
import type { ResolvedRunsOnAll } from './dashboard-fleet-handler.js';

/** Pull the first static job's runsOnAll predicate from a parsed lock entry, or null. */
export function extractRunsOnAll(workflow: LockWorkflow): ResolvedRunsOnAll | null {
  for (const job of workflow.jobs) {
    if (!isLockStaticJob(job) || !job.runsOnAll) continue;
    return {
      include: job.runsOnAll.include,
      exclude: job.runsOnAll.exclude,
      onUnreachable: job.onUnreachable ?? 'hold',
    };
  }
  return null;
}

/** Find the resolved runsOnAll predicate for a workflow by name, or null. */
export async function resolveWorkflowRunsOnAll(
  db: Kysely<Database>,
  workflowName: string,
): Promise<ResolvedRunsOnAll | null> {
  const rows = await db
    .selectFrom('workflow_registrations')
    .select(['lock_entry'])
    .where('workflow_name', '=', workflowName)
    .where('disabled', '=', false)
    .execute();

  for (const row of rows) {
    let workflow: LockWorkflow;
    try {
      workflow = JSON.parse(row.lock_entry) as LockWorkflow;
    } catch {
      continue;
    }
    const predicate = extractRunsOnAll(workflow);
    if (predicate) return predicate;
  }
  return null;
}
