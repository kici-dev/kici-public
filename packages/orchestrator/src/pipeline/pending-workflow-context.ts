/**
 * Pending workflow dispatch context store, the workflow-level analogue of
 * `pending_job_contexts`: persists a held workflow's serializable dispatch
 * inputs so it can resume (reviewer approve, wait-timer expiry, concurrency
 * slot free) by re-running `dispatchMatchedWorkflow`. The live `deps` and
 * `bundle` are rebuilt on resume, never persisted.
 *
 * Writes to an in-memory Map (same-process reads) and the DB (crash recovery,
 * cross-orchestrator reads).
 */
import { sql, type Kysely } from 'kysely';
import { TERMINAL_RUN_STATES } from '@kici-dev/engine';
import type { Database } from '../db/types.js';
import {
  JobSecretsUnsealError,
  SEALED_JOB_CONFIG_KEYS,
  sealJobSecretValue,
  unsealJobSecretValue,
} from '../secrets/job-secret-seal.js';
import type { WorkflowDispatchContext } from './dispatch-matched-workflow.js';
import {
  toSerializableGlobalIdentity,
  type SerializableGlobalDispatchIdentity,
} from './global-dispatch-identity.js';

/**
 * The JSON-safe subset of a `WorkflowDispatchContext`. A global run's identity
 * is stored without its workflow bundle and credentials, which the resume
 * re-derives.
 */
export type SerializableWorkflowDispatchInputs = Omit<
  WorkflowDispatchContext,
  'deps' | 'bundle' | 'global'
> & { global?: SerializableGlobalDispatchIdentity };

export type LoadedWorkflowDispatchInputs = SerializableWorkflowDispatchInputs & {
  /**
   * Set when the row's sealed secret fields could not be decrypted; the
   * inputs then carry none of them, and the resume abandons the run.
   */
  secretsUnavailable?: string;
};

const pendingWorkflowContexts = new Map<string, LoadedWorkflowDispatchInputs>();

/** The secret fields of stored inputs: the run-wide CLI secrets and the test-run job-config secrets. */
interface WorkflowInputSecrets {
  runWideFlatSecrets?: Record<string, string>;
  extraJobConfig?: Record<string, unknown>;
}

/**
 * Split stored inputs into what the `context` column keeps and the sealed
 * secret fields. With nothing to seal, or no master key, the inputs are
 * returned as is.
 */
function sealInputs(inputs: SerializableWorkflowDispatchInputs): {
  context: SerializableWorkflowDispatchInputs;
  sealed: string | null;
} {
  const { runWideFlatSecrets, extraJobConfig, ...rest } = inputs;
  const extraSecret: Record<string, unknown> = {};
  const extraPlain: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extraJobConfig ?? {})) {
    if ((SEALED_JOB_CONFIG_KEYS as readonly string[]).includes(key)) extraSecret[key] = value;
    else extraPlain[key] = value;
  }
  const secret: WorkflowInputSecrets = {
    ...(runWideFlatSecrets && { runWideFlatSecrets }),
    ...(Object.keys(extraSecret).length > 0 && { extraJobConfig: extraSecret }),
  };
  if (Object.keys(secret).length === 0) return { context: inputs, sealed: null };
  const sealed = sealJobSecretValue(inputs.runId, secret);
  // breaks-if-wrong: an orchestrator with no master key keeps storing the inputs in plaintext
  if (sealed === null) return { context: inputs, sealed: null };
  return {
    context: { ...rest, ...(extraJobConfig && { extraJobConfig: extraPlain }) },
    sealed,
  };
}

function unsealInputs(
  context: SerializableWorkflowDispatchInputs,
  sealed: string | null | undefined,
): LoadedWorkflowDispatchInputs {
  if (sealed == null) return context;
  try {
    const secret = unsealJobSecretValue(context.runId, sealed) as WorkflowInputSecrets;
    return {
      ...context,
      ...(secret.runWideFlatSecrets && { runWideFlatSecrets: secret.runWideFlatSecrets }),
      ...(secret.extraJobConfig && {
        extraJobConfig: { ...context.extraJobConfig, ...secret.extraJobConfig },
      }),
    };
  } catch (err) {
    if (!(err instanceof JobSecretsUnsealError)) throw err;
    return { ...context, secretsUnavailable: err.message };
  }
}

export function toSerializableInputs(
  ctx: WorkflowDispatchContext,
): SerializableWorkflowDispatchInputs {
  // `dispatchWindowTokenHeld` is THIS dispatch call's pending-jobs token,
  // released before it returns; a resumed dispatch carrying it would release a
  // token it never took, stealing one held by a deferred init / dynamic task.
  const {
    deps: _deps,
    bundle: _bundle,
    dispatchWindowTokenHeld: _dispatchWindowTokenHeld,
    global,
    ...rest
  } = ctx;
  return global ? { ...rest, global: toSerializableGlobalIdentity(global) } : rest;
}

export async function storePendingWorkflowContext(
  db: Kysely<Database> | undefined,
  inputs: SerializableWorkflowDispatchInputs,
): Promise<void> {
  pendingWorkflowContexts.set(inputs.runId, inputs);
  if (db) {
    const { context, sealed } = sealInputs(inputs);
    const serialized = JSON.stringify(context);
    await db
      .insertInto('pending_workflow_contexts')
      .values({
        run_id: inputs.runId,
        org_id: inputs.resolvedOrgId,
        context: serialized,
        sealed_secrets: sealed,
      })
      .onConflict((oc) =>
        oc.column('run_id').doUpdateSet({ context: serialized, sealed_secrets: sealed }),
      )
      .execute();
  }
}

/** Memory first, then DB. */
export async function loadPendingWorkflowContext(
  db: Kysely<Database> | undefined,
  runId: string,
): Promise<LoadedWorkflowDispatchInputs | null> {
  const mem = pendingWorkflowContexts.get(runId);
  if (mem) return mem;
  if (!db) return null;
  const row = await db
    .selectFrom('pending_workflow_contexts')
    .selectAll()
    .where('run_id', '=', runId)
    .executeTakeFirst();
  return row
    ? unsealInputs(row.context as unknown as SerializableWorkflowDispatchInputs, row.sealed_secrets)
    : null;
}

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
 * Restore the in-memory Map from the DB on startup, mirroring
 * `restorePendingJobContexts`. Returns the number restored.
 */
export async function restorePendingWorkflowContexts(db: Kysely<Database>): Promise<number> {
  // Delete rows of terminal runs first: they linger when the orchestrator
  // crashed before the fire-and-forget deletePendingWorkflowContext finished.
  await db
    .deleteFrom('pending_workflow_contexts')
    .where(
      'run_id',
      'in',
      db
        .selectFrom('execution_runs')
        .select(sql<string>`run_id::text`.as('run_id'))
        .where('status', 'in', [...TERMINAL_RUN_STATES]),
    )
    .execute();

  const rows = await db.selectFrom('pending_workflow_contexts').selectAll().execute();
  let restored = 0;
  for (const row of rows) {
    pendingWorkflowContexts.set(
      row.run_id,
      unsealInputs(
        row.context as unknown as SerializableWorkflowDispatchInputs,
        row.sealed_secrets,
      ),
    );
    restored++;
  }
  return restored;
}

/** @internal Exported for testing only. */
export function clearPendingWorkflowContextsMap(): void {
  pendingWorkflowContexts.clear();
}
