/**
 * Pending workflow dispatch context store — the workflow-level analogue of the
 * `pending_job_contexts` store. Persists the serializable inputs of a
 * `WorkflowDispatchContext` so a workflow whose install gate held can be
 * resumed (reviewer approve, wait-timer expiry, concurrency slot free) by
 * rebuilding the dispatch context and re-running `dispatchMatchedWorkflow`.
 *
 * Only the serializable inputs are stored — the live `deps` (ProcessingDeps)
 * and `bundle` (ProviderBundle) are NOT persisted; they are rebuilt from the
 * live orchestrator on resume.
 *
 * Writes to both an in-memory Map (fast read on the same process) and the DB
 * (crash recovery + cross-orchestrator read), mirroring the pending-job store.
 */
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { WorkflowDispatchContext } from './dispatch-matched-workflow.js';

/**
 * The serializable subset of a `WorkflowDispatchContext` — everything except
 * the live `deps` and `bundle`, which are rebuilt on resume. Every field here
 * is JSON-safe (the event, payload, and lock file already ride the WS protocol
 * as JSON).
 */
export type SerializableWorkflowDispatchInputs = Omit<WorkflowDispatchContext, 'deps' | 'bundle'>;

const pendingWorkflowContexts = new Map<string, SerializableWorkflowDispatchInputs>();

/** Extract the serializable inputs from a live dispatch context. */
export function toSerializableInputs(
  ctx: WorkflowDispatchContext,
): SerializableWorkflowDispatchInputs {
  // Strip the two non-serializable deps; everything else is JSON-safe.
  const { deps: _deps, bundle: _bundle, ...rest } = ctx;
  return rest;
}

/** Persist the pending workflow context to the in-memory Map and the DB. */
export async function storePendingWorkflowContext(
  db: Kysely<Database> | undefined,
  inputs: SerializableWorkflowDispatchInputs,
): Promise<void> {
  pendingWorkflowContexts.set(inputs.runId, inputs);
  if (db) {
    const serialized = JSON.stringify(inputs);
    await db
      .insertInto('pending_workflow_contexts')
      .values({ run_id: inputs.runId, org_id: inputs.resolvedOrgId, context: serialized })
      .onConflict((oc) => oc.column('run_id').doUpdateSet({ context: serialized }))
      .execute();
  }
}

/** Load the pending workflow context by run id (memory first, then DB). */
export async function loadPendingWorkflowContext(
  db: Kysely<Database> | undefined,
  runId: string,
): Promise<SerializableWorkflowDispatchInputs | null> {
  const mem = pendingWorkflowContexts.get(runId);
  if (mem) return mem;
  if (!db) return null;
  const row = await db
    .selectFrom('pending_workflow_contexts')
    .selectAll()
    .where('run_id', '=', runId)
    .executeTakeFirst();
  return row ? (row.context as unknown as SerializableWorkflowDispatchInputs) : null;
}

/** Delete the pending workflow context from the in-memory Map and the DB. */
export async function deletePendingWorkflowContext(
  db: Kysely<Database> | undefined,
  runId: string,
): Promise<void> {
  pendingWorkflowContexts.delete(runId);
  if (db) {
    await db.deleteFrom('pending_workflow_contexts').where('run_id', '=', runId).execute();
  }
}

/**
 * Restore the in-memory Map from the DB on startup, skipping rows whose run has
 * already reached a terminal state. Mirrors `restorePendingJobContexts`.
 * Returns the number of restored contexts.
 */
export async function restorePendingWorkflowContexts(db: Kysely<Database>): Promise<number> {
  const rows = await db.selectFrom('pending_workflow_contexts').selectAll().execute();
  let restored = 0;
  for (const row of rows) {
    pendingWorkflowContexts.set(
      row.run_id,
      row.context as unknown as SerializableWorkflowDispatchInputs,
    );
    restored++;
  }
  return restored;
}

/**
 * Clear all entries from the in-memory pending workflow contexts Map.
 * @internal Exported for testing only.
 */
export function clearPendingWorkflowContextsMap(): void {
  pendingWorkflowContexts.clear();
}
