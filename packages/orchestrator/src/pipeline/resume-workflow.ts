/**
 * Resume a workflow whose install gate held.
 *
 * The release path (reviewer approve, wait-timer expiry, concurrency slot free)
 * loads the persisted serializable dispatch inputs, re-attaches the live
 * orchestrator deps + the provider bundle (looked up from the live registry by
 * routing key), and re-runs `dispatchMatchedWorkflow` with
 * `skipInstallProtectionGate: true` so the dispatch flows past the (already
 * satisfied) gate into job dispatch against the same held run row.
 */
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { InitFailureCategory } from '@kici-dev/engine';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { ProcessingDeps } from './processor.js';
import type { ReleaseSignal } from '../environments/held-runs.js';
import {
  dispatchMatchedWorkflow,
  type WorkflowDispatchContext,
} from './dispatch-matched-workflow.js';
import {
  loadPendingWorkflowContext,
  deletePendingWorkflowContext,
  type SerializableWorkflowDispatchInputs,
} from './pending-workflow-context.js';

const logger = createLogger({ prefix: 'resume-workflow' });

/**
 * Rebuild a live `WorkflowDispatchContext` from the persisted serializable
 * inputs by re-attaching the orchestrator's live `deps` and reconstructing the
 * provider `bundle` from the live registry (keyed by the stored routing key).
 * Returns null when the provider bundle can no longer be resolved.
 */
export function rebuildWorkflowDispatchContext(
  inputs: SerializableWorkflowDispatchInputs,
  deps: ProcessingDeps,
): WorkflowDispatchContext | null {
  const bundle = deps.providerRegistry.getByRoutingKey(inputs.info.routingKey);
  if (!bundle) {
    return null;
  }
  return { ...inputs, deps, bundle };
}

/**
 * Resume a released workflow install-gate hold. Loads the pending context,
 * rebuilds the dispatch context, and re-dispatches with the gate skipped. On a
 * lost pending context (or unresolvable provider bundle) the run is failed
 * loudly rather than silently dropped.
 */
export async function resumeWorkflow(
  signal: ReleaseSignal,
  deps: ProcessingDeps,
  db: Kysely<Database> | undefined,
): Promise<void> {
  const pending = await loadPendingWorkflowContext(db, signal.runId);
  if (!pending) {
    logger.error('Workflow install-hold resume: pending context lost', {
      runId: signal.runId,
      holdId: signal.holdId,
    });
    await failRunResumeLost(deps, signal.runId, 'install-hold resume: pending context lost');
    return;
  }

  const ctx = rebuildWorkflowDispatchContext(pending, deps);
  if (!ctx) {
    logger.error('Workflow install-hold resume: provider bundle unresolvable', {
      runId: signal.runId,
      routingKey: pending.info.routingKey,
    });
    await failRunResumeLost(
      deps,
      signal.runId,
      'install-hold resume: provider bundle unresolvable',
    );
    await deletePendingWorkflowContext(db, signal.runId);
    return;
  }

  try {
    await dispatchMatchedWorkflow(ctx, {
      skipInstallProtectionGate: true,
      reuseHeldRunId: signal.holdId,
      reuseRunId: signal.runId,
    });
  } finally {
    // Delete after the resume dispatch is kicked off so a re-fired release is
    // idempotent (a second release finds no pending context).
    await deletePendingWorkflowContext(db, signal.runId);
  }
}

/**
 * Cancel a rejected workflow install-gate hold: mark the run cancelled and drop
 * the pending context.
 */
export async function rejectWorkflow(
  runId: string,
  deps: ProcessingDeps,
  db: Kysely<Database> | undefined,
  reason: string,
): Promise<void> {
  if (deps.executionTracker) {
    await deps.executionTracker.cancelHeldRun(runId, reason);
  }
  await deletePendingWorkflowContext(db, runId);
  logger.info('Rejected workflow install-gate hold; run cancelled', { runId, reason });
}

/** Fail a held run whose resume context could not be recovered. */
async function failRunResumeLost(
  deps: ProcessingDeps,
  runId: string,
  reason: string,
): Promise<void> {
  if (!deps.executionTracker) return;
  try {
    await deps.executionTracker.failRun(runId, reason, {
      scope: 'run',
      category: InitFailureCategory.enum.install_secrets,
      message: reason,
    });
  } catch (err) {
    logger.error('Failed to mark run failed after lost resume context', {
      runId,
      error: toErrorMessage(err),
    });
  }
}
