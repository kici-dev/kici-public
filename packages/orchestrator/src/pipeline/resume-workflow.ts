/**
 * Resume a workflow-scoped hold.
 *
 * Reached by a hold that stores a pending workflow context — the two writers of
 * one are `holdWorkflowForInstallGate` (reviewer approve, wait-timer expiry,
 * concurrency slot free) and `holdRunForSecurityPolicy`, the org trust policy's
 * PR-wide hold released by `/kici approve`. Both hold before their workflow has
 * any dispatched job, so there is nothing to re-dispatch and the whole dispatch
 * is replayed instead. `routeRelease` sends both here, and sends the SDK's
 * workflow-scoped `explicit` approval to the job path, since that one holds real
 * root jobs and stores no workflow context.
 *
 * The release loads the persisted serializable dispatch inputs, re-attaches the
 * live orchestrator deps + the provider bundle (looked up from the live registry
 * by routing key), and re-runs `dispatchMatchedWorkflow` against the same held
 * run row.
 *
 * Which gate held decides what the replay may skip — see `skipsInstallGate`.
 */
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import {
  CheckRunConclusion,
  HoldScope,
  InitFailureCategory,
  INSTALL_JOB_ID_PREFIX,
} from '@kici-dev/engine';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { ProcessingDeps } from './processor.js';
import type { ReleaseSignal } from '../contexts/held-runs.js';
import {
  dispatchMatchedWorkflow,
  type WorkflowDispatchContext,
} from './dispatch-matched-workflow.js';
import {
  loadPendingWorkflowContext,
  deletePendingWorkflowContext,
  type SerializableWorkflowDispatchInputs,
} from './pending-workflow-context.js';
import { completeUndispatchedHoldChecks } from './undispatched-hold-checks.js';
import {
  buildHoldEndedSummary,
  settleSecurityHoldCheck,
  HoldOutcome,
  type SecurityCheckHold,
} from './security-hold-check.js';

const logger = createLogger({ prefix: 'resume-workflow' });

/**
 * Rebuild a live `WorkflowDispatchContext` from the persisted serializable
 * inputs by re-attaching the orchestrator's live `deps` and reconstructing the
 * provider `bundle` from the live registry (keyed by the stored routing key).
 * Returns null when the provider bundle can no longer be resolved.
 *
 * The key it looks the bundle up by is `effectiveRoutingKey ?? info.routingKey`
 * — the post-overlay key, the same one `setupDispatchContext` builds
 * `setup.info` from and the same one the run row records. `info.routingKey` is
 * the INBOUND key and never carries the overlay, so on a cross-source or
 * fallback-resolved dispatch it names the source the event arrived on rather
 * than the source the workflow belongs to: the resumed run would get the wrong
 * app, the wrong credentials, and a check poster writing to the wrong place.
 */
export function rebuildWorkflowDispatchContext(
  inputs: SerializableWorkflowDispatchInputs,
  deps: ProcessingDeps,
): WorkflowDispatchContext | null {
  const bundle = deps.providerRegistry.getByRoutingKey(
    inputs.effectiveRoutingKey ?? inputs.info.routingKey,
  );
  if (!bundle) {
    return null;
  }
  return {
    ...inputs,
    // A stored context is JSON cast straight back to its type, so a row written
    // before this field existed carries no value however the type reads. Such a
    // row can only be a per-repository or cross-source context — both define
    // the workflow in the repository the run acts on — so the acted-on
    // repository is the correct answer for every one of them, not a guess.
    workflowRepoIdentifier: inputs.workflowRepoIdentifier ?? inputs.repoIdentifier,
    deps,
    bundle,
  };
}

/**
 * Whether this released hold WAS the workflow install gate, and so may resume
 * past it.
 *
 * `holdWorkflowForInstallGate` is the one held-run writer that calls
 * `installGateJobId(workflow.name)`, so that prefix identifies its rows. The
 * other hold that reaches this resume — the org trust policy's PR-wide hold — is
 * decided by `applyTrustPolicyGate`, which runs BEFORE
 * `resolveWorkflowInstallSecrets`, so its replay has not satisfied the install
 * gate and has no claim to skip it. An unrecognised `job_id` resolves the same
 * way, which is the fail-closed direction: the worst case is a gate evaluated
 * once more.
 *
 * On today's trust-policy path this is inert, and deliberately kept anyway.
 * `skipProtectionGate` reaches only `fireProtectionRulesPerEnv`, and
 * `resolveInstallSecrets` strips an untrusted contributor's install secrets and
 * returns BEFORE it — so for a run that already has a non-trusted tier the flag
 * decides nothing either way. Every trust-policy hold is such a run:
 * `evaluateSecurityPolicy` passes unless the provider bundle has a fork model,
 * which is the same condition under which trust resolution always yields a tier,
 * and `evaluateTrustPolicy` passes `trusted`. What the derivation guards is the
 * case where a tier is ABSENT — `isUntrustedTier` reads `undefined` leniently
 * and leaves the secrets in place, so such a run does reach the gate. No arm
 * produces that pairing today; this keeps the fail-closed answer ready for one
 * that does, rather than resting on a coincidence two modules apart.
 */
function skipsInstallGate(signal: ReleaseSignal): boolean {
  return signal.jobId.startsWith(INSTALL_JOB_ID_PREFIX);
}

/**
 * Resume a released workflow-scoped hold. Loads the pending context, rebuilds
 * the dispatch context, and re-dispatches. On a lost pending context (or
 * unresolvable provider bundle) the run is failed loudly rather than silently
 * dropped.
 */
export async function resumeWorkflow(
  signal: ReleaseSignal,
  deps: ProcessingDeps,
  db: Kysely<Database> | undefined,
): Promise<void> {
  const skipInstallProtectionGate = skipsInstallGate(signal);
  // Names the gate that held, so a lost-context failure points at the right one.
  const gate = skipInstallProtectionGate ? 'install-hold' : 'workflow-hold';
  const category = skipInstallProtectionGate
    ? InitFailureCategory.enum.install_secrets
    : InitFailureCategory.enum.trust_policy;
  const pending = await loadPendingWorkflowContext(db, signal.runId);
  if (!pending) {
    logger.error('Workflow hold resume: pending context lost', {
      runId: signal.runId,
      holdId: signal.holdId,
      gate,
    });
    // The hold's queued check runs stay on the commit here. Their names come
    // from the context, and the context is what was lost — closing them would
    // need provider-side discovery by sha, the way `cleanupStaleCheckRuns`
    // works. `failRunResumeLost` at least writes a terminal, queryable run.
    await failRunResumeLost(deps, signal.runId, `${gate} resume: pending context lost`, category);
    return;
  }

  const ctx = rebuildWorkflowDispatchContext(pending, deps);
  if (!ctx) {
    logger.error('Workflow hold resume: provider bundle unresolvable', {
      runId: signal.runId,
      // The key the lookup actually used, which is the post-overlay one. On a
      // cross-source resume `info.routingKey` still names the INBOUND source, so
      // logging it hands an operator the source that did not fail to resolve.
      routingKey: pending.effectiveRoutingKey ?? pending.info.routingKey,
      gate,
    });
    await failRunResumeLost(
      deps,
      signal.runId,
      `${gate} resume: provider bundle unresolvable`,
      category,
    );
    // The run is terminal and this release will not be retried, so the queued
    // check runs the held dispatch posted have to be closed here. Unlike the
    // branch above, the context loaded — so their names are in hand — and it is
    // deleted on the next line.
    await completeUndispatchedHoldChecks({
      db,
      checkRunReporter: deps.checkRunReporter,
      runId: signal.runId,
      conclusion: CheckRunConclusion.enum.failure,
      summary:
        `This run could not be resumed after its ${gate} was released, so no job started. ` +
        'Push a new commit to have the pull request evaluated again.',
    });
    await deletePendingWorkflowContext(db, signal.runId);
    return;
  }

  // Correlates the resumed dispatch with the hold that released it. Logged here
  // rather than passed into the dispatch, which has no reader for it.
  logger.info('Resuming a released workflow-scoped hold', {
    runId: signal.runId,
    holdId: signal.holdId,
    gate,
    skipInstallProtectionGate,
  });

  try {
    await dispatchMatchedWorkflow(ctx, {
      skipInstallProtectionGate,
      reuseRunId: signal.runId,
    });
  } finally {
    // Delete after the resume dispatch is kicked off so a re-fired release is
    // idempotent (a second release finds no pending context).
    await deletePendingWorkflowContext(db, signal.runId);
  }
}

/**
 * Cancel a rejected workflow-scoped hold (install gate or trust policy): mark
 * the run cancelled, complete the check runs the dispatch already posted, and
 * drop the pending context.
 *
 * The check runs are completed `cancelled`, matching the run row this writes —
 * `cancelHeldRun` sets `execution_runs.status` to `cancelled` with failure class
 * `cancelled`. Without this the workflow and per-job checks stay `queued` on the
 * commit for a run that will never start; see `completeUndispatchedHoldChecks`.
 * It runs before the delete because the pending context is what the check-run
 * names are derived from.
 *
 * The hold row decides whether the `KiCI Security` check is terminalized too:
 * the trust policy's PR-wide hold and the SDK's workflow-level `requireApproval`
 * each posted one pending, while the install gate posted none and must not have
 * one fabricated. That is `postedPendingSecurityCheck`'s job — see it for the
 * per-shape derivation, and for why `queue_type` cannot make the distinction.
 *
 * This is the single writer of that check for a rejection, on both surfaces the
 * shared applier serves: the dashboard / CLI / MCP reject reaches it through
 * `applyDecision`'s `onWorkflowReject`, and `/kici reject` through the comment
 * handler's. Both therefore render identically on the pull request, and the
 * summary below is the one both check families carry. The returned boolean says
 * whether a security check was actually WRITTEN, so a caller suppresses its own
 * post on the strength of a write rather than of a delegate resolving —
 * a rejection this declines to report (an install gate, or a commit whose other
 * holds are still pending) leaves the caller free to decide for itself.
 */
export async function rejectWorkflow(
  hold: SecurityCheckHold,
  deps: ProcessingDeps,
  db: Kysely<Database> | undefined,
  reason: string,
): Promise<boolean> {
  const runId = hold.run_id;
  if (deps.executionTracker) {
    await deps.executionTracker.cancelHeldRun(runId, reason);
  }
  // One summary for both check families — the sameness is asserted, not assumed.
  const summary = buildHoldEndedSummary({
    outcome: HoldOutcome.Rejected,
    scope: HoldScope.enum.workflow,
    reason,
  });
  await completeUndispatchedHoldChecks({
    db,
    checkRunReporter: deps.checkRunReporter,
    runId,
    conclusion: CheckRunConclusion.enum.cancelled,
    summary,
  });
  const settled = await settleSecurityHoldCheck({
    db,
    resolvePoster: (routingKey) =>
      deps.providerRegistry.getByRoutingKey(routingKey)?.checkStatusPoster,
    hold,
    status: CheckRunConclusion.enum.cancelled,
    title: 'Rejected',
    summary,
  });
  await deletePendingWorkflowContext(db, runId);
  logger.info('Rejected workflow-scoped hold; run cancelled', {
    runId,
    reason,
    holdJobId: hold.job_id,
    securityCheck: settled.outcome,
  });
  return settled.posted;
}

/** Fail a held run whose resume context could not be recovered. */
async function failRunResumeLost(
  deps: ProcessingDeps,
  runId: string,
  reason: string,
  category: InitFailureCategory,
): Promise<void> {
  if (!deps.executionTracker) return;
  try {
    await deps.executionTracker.failRun(runId, reason, {
      scope: 'run',
      category,
      message: reason,
    });
  } catch (err) {
    logger.error('Failed to mark run failed after lost resume context', {
      runId,
      error: toErrorMessage(err),
    });
  }
}
