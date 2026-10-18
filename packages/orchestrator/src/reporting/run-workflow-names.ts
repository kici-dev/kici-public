/**
 * The workflows a run spans, read from its job rows.
 *
 * An older `kici`'s shared fixture run holds every
 * matched workflow. `execution_runs.workflow_name` holds the first of them; each job row
 * records its own in `execution_jobs.workflow_name`.
 */
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';

/** The run fields the readers below need. */
export interface RunWorkflowRef {
  run_id: string;
  workflow_name: string;
}

/**
 * Every workflow each run spans, the run's own workflow first and the rest in
 * the order their first job registered. A run whose job rows name no workflow
 * (written before the column existed) lists its own workflow alone.
 */
export async function loadRunWorkflowNames(
  db: Kysely<Database>,
  runs: readonly RunWorkflowRef[],
): Promise<Map<string, string[]>> {
  const names = new Map<string, string[]>(runs.map((r) => [r.run_id, [r.workflow_name]]));
  if (runs.length === 0) return names;
  const rows = await db
    .selectFrom('execution_jobs')
    .select((eb) => ['run_id', 'workflow_name', eb.fn.min('created_at').as('first_at')])
    .where(
      'run_id',
      'in',
      runs.map((r) => r.run_id),
    )
    .where('workflow_name', 'is not', null)
    .groupBy(['run_id', 'workflow_name'])
    .orderBy('first_at', 'asc')
    .orderBy('workflow_name', 'asc')
    .execute();
  for (const row of rows) {
    const list = names.get(row.run_id);
    if (list && row.workflow_name && !list.includes(row.workflow_name)) {
      list.push(row.workflow_name);
    }
  }
  return names;
}

/**
 * The workflow a job row belongs to. A row written before the column existed
 * records none: a run that is not a fixture run spans one workflow, so the
 * run's own names it; a fixture run may span several, so it stays unknown.
 */
export function jobWorkflowName(
  jobWorkflow: string | null,
  run: { workflow_name: string; is_test_run: boolean },
): string | null {
  if (jobWorkflow) return jobWorkflow;
  return run.is_test_run ? null : run.workflow_name;
}
