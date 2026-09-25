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
 *
 * A held pre-run global evaluation round shares the org trust policy's hold row
 * but stores no dispatch context: its release re-evaluates the round from the
 * stored webhook payload (`releaseHeldGlobalEvalRound`).
 */
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import {
  CheckRunConclusion,
  ExecutionRunStatus,
  HoldScope,
  InitFailureCategory,
  INSTALL_JOB_ID_PREFIX,
} from '@kici-dev/engine';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { ProcessingDeps } from './processor.js';
import type { ProviderBundle } from '../provider-registry.js';
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
import { ROUND_JOB_PREFIX } from './global-eval-round.js';
import { mintWorkflowRepoCredentials } from './global-dispatch.js';
import type {
  GlobalDispatchIdentity,
  SerializableGlobalDispatchIdentity,
} from './global-dispatch-identity.js';
import {
  buildHoldEndedSummary,
  settleSecurityHoldCheck,
  HoldOutcome,
  type SecurityCheckHold,
} from './security-hold-check.js';

const logger = createLogger({ prefix: 'resume-workflow' });

/**
 * A global run's identity rebuilt from its stored hold, before the workflow
 * repository's credentials are minted. It has no `workflowCredentials`, so a
 * context carrying it is not a {@link WorkflowDispatchContext}.
 */
export type UnmintedGlobalIdentity = Omit<
  GlobalDispatchIdentity,
  'workflowCredentials' | 'workflowBundle'
> & {
  readonly workflowBundle: ProviderBundle;
};

/**
 * A dispatch context rebuilt from a stored hold. `dispatchMatchedWorkflow`
 * does not accept it: only {@link withWorkflowRepoCredentials} turns it into a
 * {@link WorkflowDispatchContext}, so a resume cannot dispatch a global run
 * without a freshly minted clone token.
 */
export type RebuiltWorkflowDispatchContext = Omit<WorkflowDispatchContext, 'global'> & {
  global?: UnmintedGlobalIdentity;
};

/**
 * Rebuild a live `WorkflowDispatchContext` from the persisted serializable
 * inputs by re-attaching the orchestrator's live `deps` and reconstructing the
 * provider `bundle` from the live registry (keyed by the stored routing key).
 * Returns null when the provider bundle can no longer be resolved.
 *
 * A global run's identity is rebuilt from what was stored at hold time — the
 * workflow commit, branch and provider context it was held at — never from the
 * live registration, which may have moved to a newer commit while the run
 * waited. Its workflow bundle is looked up by the stored workflow routing key,
 * and it has no credentials until {@link withWorkflowRepoCredentials} mints
 * them. Returns null when the workflow bundle can no longer be resolved either.
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
): RebuiltWorkflowDispatchContext | null {
  const bundle = deps.providerRegistry.getByRoutingKey(
    inputs.effectiveRoutingKey ?? inputs.info.routingKey,
  );
  if (!bundle) {
    return null;
  }
  const { global: storedGlobal, ...rest } = inputs;
  const global = storedGlobal ? rebuildGlobalIdentity(storedGlobal, deps) : undefined;
  // fails-when: a held global run resumes although its workflow repository's source is gone
  // breaks-if-wrong: a same-repo run (no stored global) must still rebuild
  if (storedGlobal && !global) {
    return null;
  }
  return {
    ...rest,
    // A stored context is JSON cast straight back to its type, so a row written
    // before this field existed carries no value however the type reads. Such a
    // row can only be a per-repository or cross-source context — both define
    // the workflow in the repository the run acts on — so the acted-on
    // repository is the correct answer for every one of them, not a guess.
    workflowRepoIdentifier:
      inputs.global?.workflowRepoIdentifier ??
      inputs.workflowRepoIdentifier ??
      inputs.repoIdentifier,
    ...(global && { global }),
    deps,
    bundle,
  };
}

/**
 * The live global identity of a held run, from its stored fields: the workflow
 * bundle is looked up by the stored routing key. Undefined when that key has
 * no bundle. Fields are picked one by one, so a row stored with a serialized
 * bundle or a clone token does not carry either into the resume.
 */
function rebuildGlobalIdentity(
  g: SerializableGlobalDispatchIdentity,
  deps: ProcessingDeps,
): UnmintedGlobalIdentity | undefined {
  const workflowBundle = deps.providerRegistry.getByRoutingKey(g.workflowRoutingKey);
  if (!workflowBundle) return undefined;
  return {
    workflowRepoIdentifier: g.workflowRepoIdentifier,
    workflowSha: g.workflowSha,
    workflowBranch: g.workflowBranch,
    workflowRoutingKey: g.workflowRoutingKey,
    workflowProviderContext: g.workflowProviderContext,
    workflowBundle,
  };
}

/**
 * The rebuilt context with fresh credentials for a global run's workflow
 * repository, minted by its bundle the way the first dispatch minted them. A
 * same-repo context gets no global identity. Throws when the mint fails.
 */
export async function withWorkflowRepoCredentials(
  rebuilt: RebuiltWorkflowDispatchContext,
): Promise<WorkflowDispatchContext> {
  const { global: g, ...rest } = rebuilt;
  // fails-when: a rebuilt global run reaches dispatch without a freshly minted token
  // breaks-if-wrong: a same-repo resume must dispatch with no global identity and no mint
  if (!g) return rest;
  const workflowCredentials = await mintWorkflowRepoCredentials(g.workflowBundle, {
    repoIdentifier: g.workflowRepoIdentifier,
    providerContext: g.workflowProviderContext,
  });
  return { ...rest, global: { ...g, workflowCredentials } };
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
 * `skipProtectionGate` only selects the install gate's release path
 * (`gateReleasedInstall`), and `resolveInstallSecrets` strips an untrusted
 * contributor's install secrets and returns BEFORE the gate — so for a run that already has a non-trusted tier the flag
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
  // A held pre-run evaluation round stores no dispatch context: its release
  // re-evaluates the round from the stored webhook payload instead of replaying
  // a workflow dispatch.
  if (await isHeldGlobalEvalRound(db, signal.runId)) {
    logger.info('Releasing a held global evaluation round', {
      runId: signal.runId,
      holdId: signal.holdId,
    });
    // Imported on use: the release re-drives the organization-wide pass, whose
    // module imports this one.
    const { releaseHeldGlobalEvalRound } = await import('./rerun.js');
    await releaseHeldGlobalEvalRound(signal.runId, deps);
    return;
  }
  const skipInstallProtectionGate = skipsInstallGate(signal);
  // Names the gate that held, so a lost-context failure points at the right one.
  const gate = skipInstallProtectionGate ? 'install-hold' : 'workflow-hold';
  const category = skipInstallProtectionGate
    ? InitFailureCategory.enum.install_secrets
    : InitFailureCategory.enum.trust_policy;
  const pending = await loadPendingWorkflowContext(db, signal.runId);
  const leftHeld = pending ? undefined : await runLeftHeld(db, signal.runId);
  if (leftHeld) {
    // A release that already resumed this run consumed its context. This signal
    // is a re-fired one, and failing the run here would fail the resumed run.
    // A `pending` row with no job rows is the exception worth a warning: the
    // claim moved the row but no dispatch followed, so the run may be stranded.
    const stranded = leftHeld.status === ExecutionRunStatus.enum.pending && !leftHeld.hasJobs;
    // fails-when: a stranded claim is logged at info and never reaches an operator's warn view
    // breaks-if-wrong: a re-fired release racing a live resume must stay at info
    const fields = { runId: signal.runId, holdId: signal.holdId, status: leftHeld.status };
    if (stranded) {
      logger.warn(
        'Workflow hold resume: run was claimed by another release but has no jobs',
        fields,
      );
    } else {
      logger.info('Workflow hold resume: run already resumed by another release', fields);
    }
    return;
  }
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

  // fails-when: a held run whose sealed secrets cannot be decrypted resumes without them
  // breaks-if-wrong: a held run whose seal opened, or that stored none, resumes as before
  if (pending.secretsUnavailable) {
    logger.error('Workflow hold resume: stored secrets cannot be decrypted', {
      runId: signal.runId,
      gate,
      error: pending.secretsUnavailable,
    });
    await abandonUnresumableRun(
      { deps, db, runId: signal.runId, gate, category },
      pending.secretsUnavailable,
    );
    return;
  }
  const rebuilt = rebuildWorkflowDispatchContext(pending, deps);
  if (!rebuilt) {
    logger.error('Workflow hold resume: provider bundle unresolvable', {
      runId: signal.runId,
      // The key the lookup actually used, which is the post-overlay one. On a
      // cross-source resume `info.routingKey` still names the INBOUND source, so
      // logging it hands an operator the source that did not fail to resolve.
      routingKey: pending.effectiveRoutingKey ?? pending.info.routingKey,
      ...(pending.global && { workflowRoutingKey: pending.global.workflowRoutingKey }),
      gate,
    });
    await abandonUnresumableRun(
      { deps, db, runId: signal.runId, gate, category },
      'provider bundle unresolvable',
    );
    return;
  }
  let ctx: WorkflowDispatchContext;
  try {
    ctx = await withWorkflowRepoCredentials(rebuilt);
  } catch (err) {
    logger.error('Workflow hold resume: cannot mint credentials for the workflow repository', {
      runId: signal.runId,
      workflowRepo: rebuilt.global?.workflowRepoIdentifier,
      gate,
      error: toErrorMessage(err),
    });
    await abandonUnresumableRun(
      { deps, db, runId: signal.runId, gate, category },
      'workflow repository credentials unavailable',
    );
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
  opts: { runHeld?: boolean } = {},
): Promise<boolean> {
  const runId = hold.run_id;
  // A run that is not `held` (a cancel withdrawing a hold raised at dispatch)
  // is ended by its caller's job cancellation; the held-run write matches no row.
  const runHeld = opts.runHeld ?? true;
  if (deps.executionTracker && runHeld) {
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
  logger.info(
    runHeld
      ? 'Rejected workflow-scoped hold; run cancelled'
      : 'Rejected workflow-scoped hold; run left to its job cancellation',
    {
      runId,
      reason,
      holdJobId: hold.job_id,
      securityCheck: settled.outcome,
    },
  );
  return settled.posted;
}

/**
 * Whether `runId` is a held global evaluation round, recognised by the run
 * row's structural marker. The row's `__globaleval__` name is not enough on
 * its own: a customer workflow may carry the same prefix.
 */
async function isHeldGlobalEvalRound(
  db: Kysely<Database> | undefined,
  runId: string,
): Promise<boolean> {
  if (!db) return false;
  const row = await db
    .selectFrom('execution_runs')
    .select(['is_global_eval_round', 'workflow_name'])
    .where('run_id', '=', runId)
    .executeTakeFirst();
  // fails-when: a held round is replayed as a workflow dispatch and fails on its missing context
  // breaks-if-wrong: a held workflow run must still resume through its stored context
  return row?.is_global_eval_round === true && row.workflow_name.startsWith(ROUND_JOB_PREFIX);
}

/**
 * The run row's status and whether it has job rows, when it records a status
 * other than `held` — another release resumed it. Undefined when there is no
 * database or the row records no status or `held`, so a genuinely lost context
 * still fails the run.
 */
async function runLeftHeld(
  db: Kysely<Database> | undefined,
  runId: string,
): Promise<{ status: string; hasJobs: boolean } | undefined> {
  if (!db) return undefined;
  const row = await db
    .selectFrom('execution_runs')
    .select(['status'])
    .where('run_id', '=', runId)
    .executeTakeFirst();
  // fails-when: a re-fired release fails the run the first release resumed
  // breaks-if-wrong: a held run whose context was lost must still be failed
  if (row?.status === undefined || row.status === ExecutionRunStatus.enum.held) return undefined;
  const job = await db
    .selectFrom('execution_jobs')
    .select(['job_id'])
    .where('run_id', '=', runId)
    .limit(1)
    .executeTakeFirst();
  return { status: row.status, hasJobs: job !== undefined };
}

/**
 * Fail a held run whose context loaded but cannot be dispatched, close the
 * queued check runs its held dispatch posted, and drop the context. The run is
 * terminal and this release will not be retried, so the checks are closed
 * here; their names come from the context, which is deleted last.
 */
async function abandonUnresumableRun(
  args: {
    deps: ProcessingDeps;
    db: Kysely<Database> | undefined;
    runId: string;
    gate: string;
    category: InitFailureCategory;
  },
  cause: string,
): Promise<void> {
  const { deps, db, runId, gate, category } = args;
  await failRunResumeLost(deps, runId, `${gate} resume: ${cause}`, category);
  await completeUndispatchedHoldChecks({
    db,
    checkRunReporter: deps.checkRunReporter,
    runId,
    conclusion: CheckRunConclusion.enum.failure,
    summary:
      `This run could not be resumed after its ${gate} was released, so no job started. ` +
      'Push a new commit to have the pull request evaluated again.',
  });
  await deletePendingWorkflowContext(db, runId);
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
