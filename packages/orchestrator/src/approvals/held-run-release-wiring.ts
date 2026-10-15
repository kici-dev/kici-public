/**
 * The release wiring of the local (`kici-admin`) held-run decision surface,
 * composed by `createApp` for every mode. A factory rather than an inline
 * literal so a test can assert its fields: the defect it guards is a MISSING
 * field — a release that flips the `held_runs` row without dispatching looks
 * like it works and does nothing.
 *
 * `undefined` without a job-release callback, so no decision route is mounted
 * rather than one whose approves are silent no-ops.
 *
 * Callbacks read the LIVE processing-deps bag at call time: sources reloading
 * swap the provider registry, and a captured bag would resolve a check poster
 * from a registry that no longer serves the routing key.
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
 * The reason recorded on the run when a workflow-scoped hold is rejected here
 * with none supplied. Scope-neutral on purpose: the install gate, the org trust
 * policy's PR-wide hold and an SDK workflow-level `requireApproval` all arrive
 * here, so naming one would mislabel the others.
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
    // A reject must cancel the run and drop the pending dispatch context, not
    // merely flip the row, or the run stays `held` forever with its context
    // stranded. Built from the live bag, as the direct-ingress pipeline does.
    onWorkflowReject: (hold, reason) => {
      const procDeps = buildProcessingDeps();
      return rejectWorkflow(hold, procDeps, procDeps.db, reason ?? DEFAULT_LOCAL_REJECT_REASON);
    },
    resolveCheckStatusPoster: (routingKey) =>
      buildProcessingDeps().providerRegistry.getByRoutingKey(routingKey)?.checkStatusPoster,
  };
}
