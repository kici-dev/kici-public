/**
 * The release wiring the local (`kici-admin`) held-run decision surface runs on.
 *
 * `createApp` composes this for every mode. It lives here rather than inline in
 * that composition root because the defect it guards against is a MISSING
 * field, not a wrong algorithm: a release path that flips the `held_runs` row
 * without dispatching looks like it works and does nothing. A factory can be
 * constructed by a test and its fields asserted; an object literal buried in
 * `createApp` cannot.
 *
 * It returns `undefined` when there is no job-release callback, so an app
 * assembled without one mounts no decision route at all rather than one whose
 * approves are silent no-ops.
 *
 * Every callback reads the LIVE processing-deps bag at call time rather than
 * capturing one: the provider registry is swapped whenever sources reload, and
 * a captured bag would resolve a check poster from a registry that no longer
 * serves the routing key.
 */
import type { ReleaseSignal } from '../contexts/held-runs.js';
import type { ProcessingDeps } from '../pipeline/processor.js';
import { rejectWorkflow } from '../pipeline/resume-workflow.js';
import type { HeldRunReleaseWiring } from '../routes/admin-held-runs.js';

/** The subset of `createApp`'s deps this factory reads. */
export interface HeldRunReleaseInputs {
  /**
   * Re-dispatch a released job-scoped hold. Supplied by both mode hooks through
   * `appDepsExtras`; its absence is what makes the whole surface absent.
   */
  onJobRelease?: ((signal: ReleaseSignal) => Promise<void>) | undefined;
  /** Replay the stored dispatch context of a released workflow-scoped hold. */
  onWorkflowRelease?: ((signal: ReleaseSignal) => Promise<void>) | undefined;
  /** The live processing-deps bag, assembled per call. */
  buildProcessingDeps: () => ProcessingDeps;
}

/**
 * The reason a workflow-scoped hold rejected through this surface records on the
 * run it cancels, when the operator supplied none.
 *
 * Scope-neutral on purpose: the install gate, the org trust policy's PR-wide
 * hold and an SDK workflow-level `requireApproval` all arrive here, so a
 * reason naming one of them would mislabel the other two.
 */
export const DEFAULT_LOCAL_REJECT_REASON = 'Workflow hold rejected by the orchestrator operator';

export function buildHeldRunRelease(
  inputs: HeldRunReleaseInputs,
): HeldRunReleaseWiring | undefined {
  const { onJobRelease, onWorkflowRelease, buildProcessingDeps } = inputs;
  if (!onJobRelease) return undefined;
  return {
    onJobRelease,
    ...(onWorkflowRelease && { onWorkflowRelease }),
    // Rejecting a workflow-scoped hold must cancel the run and drop the pending
    // dispatch context, not merely flip the row: without it the run stays alive
    // in `held` forever and the context that would have replayed it is
    // stranded. Built from the live bag, exactly as the direct-ingress pipeline
    // builds its own.
    onWorkflowReject: (hold, reason) => {
      const procDeps = buildProcessingDeps();
      return rejectWorkflow(hold, procDeps, procDeps.db, reason ?? DEFAULT_LOCAL_REJECT_REASON);
    },
    resolveCheckStatusPoster: (routingKey) =>
      buildProcessingDeps().providerRegistry.getByRoutingKey(routingKey)?.checkStatusPoster,
  };
}
