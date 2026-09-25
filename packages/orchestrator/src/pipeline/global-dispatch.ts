/**
 * Dispatch of an organization-wide (global) workflow for an event from another
 * repository, through the same pipeline a per-repository workflow uses.
 *
 * The global pass upstream decides WHICH candidates run (policy, `requires`,
 * the eval round). Each surviving candidate is then handed to
 * `dispatchMatchedWorkflow` with a {@link GlobalDispatchIdentity}, so contexts,
 * holds, approvals, caches, needs edges and gates behave exactly as they do for
 * a workflow defined in the event's own repository.
 */
import { randomUUID } from 'node:crypto';
import { createLogger, enrichRequestContext, toErrorMessage } from '@kici-dev/shared';
import type {
  LockJobOrFactory,
  LockWorkflow,
  SimulatedEvent,
  WorkflowDecision,
} from '@kici-dev/engine';
import type { WebhookInfo } from '../webhook/handler.js';
import type { ProviderBundle } from '../provider-registry.js';
import type { RegisteredWorkflow } from '../registration/registration-index.js';
import type { TrustResolution } from '../security/trust-resolver.js';
import type { TrustPolicyOutcome } from '../security/trust-policy-gate.js';
import {
  dispatchMatchedWorkflow,
  type WorkflowDispatchContext,
} from './dispatch-matched-workflow.js';
import type { GlobalEvalCandidate } from './global-eval-round.js';
import type { ProcessingDeps } from './processor.js';

const logger = createLogger({ prefix: 'global-dispatch' });

/** Fallback source file for a registration that recorded none. */
const UNKNOWN_SOURCE_FILE = '.kici/workflows/unknown.ts';

/**
 * A global candidate handed to the pipeline, with the exact job set to dispatch.
 *
 * A round-cleared candidate carries its static jobs, the jobs the round
 * generated, and its result-aware `DynamicJobFn` entries, which the pipeline
 * evaluates on its deferred path once their upstreams complete
 * (`RoundClearedCandidate`). A candidate the event's trust verdict settles
 * before any round carries its lock-file job list as declared, `DynamicJobFn`
 * entries included: the pipeline's trust gate rejects or ignores it before any
 * job is expanded.
 */
export interface ResolvedGlobalCandidate {
  candidate: GlobalEvalCandidate;
  jobs: readonly LockJobOrFactory[];
}

/**
 * A candidate the evaluation round cleared, or one that never needed the round.
 * Its only `DynamicJobFn` entries are result-aware ones: every needs-free
 * generator was already expanded by the round.
 */
export type RoundClearedCandidate = ResolvedGlobalCandidate;

/** Inputs of one global candidate's dispatch. */
export interface GlobalCandidateDispatchArgs {
  info: WebhookInfo;
  deps: ProcessingDeps;
  payload: unknown;
  /**
   * The bundle that checks out the source repository and posts its checks.
   * The inbound event's bundle, or another source's when a cross-provider
   * lock-file fallback resolved one.
   */
  sourceBundle: ProviderBundle;
  /** Routing key `sourceBundle` belongs to, when it is not `info.routingKey`. */
  sourceRoutingKey?: string;
  sourceRepoIdentifier: string;
  /** Credentials of `sourceBundle` for the source repository. */
  sourceCredentials: Record<string, unknown>;
  event: SimulatedEvent;
  eventWithFiles: SimulatedEvent;
  /** The event's commit SHA. */
  ref: string;
  resolvedOrgId: string;
  /** The event's trust resolution, recorded on the run and read by `minimumTrust`. */
  trustResolution: TrustResolution | undefined;
  /** The event's trust-policy verdict; a `hold` holds the global run. */
  securityDecision: TrustPolicyOutcome;
  /** The candidate and its final job list (static and round-generated entries). */
  resolved: ResolvedGlobalCandidate;
}

/**
 * Credentials for the workflow repository, minted by its own provider bundle
 * with the registration's provider context. Throws when the mint fails.
 */
export async function mintWorkflowRepoCredentials(
  workflowBundle: ProviderBundle,
  reg: Pick<RegisteredWorkflow, 'repoIdentifier' | 'providerContext'>,
): Promise<Record<string, unknown>> {
  const token = await workflowBundle.cloneTokenProvider?.createCloneToken(
    reg.repoIdentifier,
    reg.providerContext,
  );
  return { ...reg.providerContext, ...(token && { token }) };
}

/**
 * A global workflow's lock entry with `jobs` as the job list to dispatch.
 *
 * The workflow `filter` was already decided before the run existed — by the
 * eval round, or by the run a re-run repeats — so it is dropped here. Otherwise
 * every job would defer to an init job that evaluates it a second time.
 */
export function dispatchableGlobalWorkflow(
  lockEntry: LockWorkflow,
  jobs: readonly LockJobOrFactory[],
): LockWorkflow {
  const { hasFilter: _alreadyDecided, ...rest } = lockEntry;
  return { ...rest, jobs: [...jobs] };
}

/**
 * The lock file a global run hands the pipeline: the one workflow it runs, with
 * the dependency-cache key of the lock file that entry came from.
 *
 * The key is what the pipeline probes the dependency cache with, and what the
 * build job publishes a tarball under, so a global run shares cache entries
 * with every other run of the same lock. `reg` must describe the lock file
 * `workflow` came from: a caller that read the entry at another commit passes
 * that commit's key. A registration that recorded no key installs its
 * dependencies on the agent.
 */
export function globalRunLockFile(
  workflow: LockWorkflow,
  reg: Pick<RegisteredWorkflow, 'sourceFile' | 'lockfileHash' | 'siblingsDigest'>,
): WorkflowDispatchContext['fullLockFile'] {
  return {
    workflows: [workflow],
    lockfileHash: reg.lockfileHash ?? undefined,
    ...(reg.siblingsDigest && { siblingsDigest: reg.siblingsDigest }),
    source: { file: reg.sourceFile ?? workflow.source?.file ?? UNKNOWN_SOURCE_FILE },
  };
}

/** The candidate's trigger decision, or a matched one when the caller carried none. */
function decisionOf(candidate: GlobalEvalCandidate): WorkflowDecision {
  return (
    candidate.decision ?? {
      workflowName: candidate.lockEntry.name,
      matched: true,
      checks: [],
      summary: 'Organization-wide workflow matched',
    }
  );
}

/**
 * Dispatches one global candidate through the shared pipeline. Returns the run
 * id, or undefined when no run was created: the workflow repository has no
 * provider bundle, its credentials cannot be minted, or the candidate has no
 * job to dispatch.
 */
export async function dispatchGlobalCandidateViaPipeline(
  args: GlobalCandidateDispatchArgs,
): Promise<string | undefined> {
  const { reg, lockEntry } = args.resolved.candidate;
  const logFields = {
    deliveryId: args.info.deliveryId,
    workflow: lockEntry.name,
    workflowRepo: reg.repoIdentifier,
    sourceRepo: args.sourceRepoIdentifier,
  };
  // A cleared candidate with no job dispatches nothing, so it gets no run: a
  // run row with zero jobs never completes and nothing reaps it.
  // fails-when: a candidate with an empty job list reaches dispatchMatchedWorkflow
  // breaks-if-wrong: a candidate with one job must still dispatch
  if (args.resolved.jobs.length === 0) {
    logger.warn('Organization-wide workflow cleared with no jobs to dispatch', logFields);
    return undefined;
  }
  const workflowBundle = args.deps.providerRegistry.getByRoutingKey(reg.routingKey);
  // fails-when: the registration's routing key has no bundle — the workflow repo cannot be cloned
  // breaks-if-wrong: a registered routing key must still dispatch
  if (!workflowBundle) {
    logger.warn('Global workflow skipped: no provider bundle for its workflow repository', {
      ...logFields,
      workflowRoutingKey: reg.routingKey,
    });
    return undefined;
  }
  let workflowCredentials: Record<string, unknown>;
  try {
    workflowCredentials = await mintWorkflowRepoCredentials(workflowBundle, reg);
  } catch (err) {
    logger.warn('Global workflow skipped: cannot mint credentials for its workflow repository', {
      ...logFields,
      error: toErrorMessage(err),
    });
    return undefined;
  }

  const workflow = dispatchableGlobalWorkflow(lockEntry, args.resolved.jobs);
  const runId = randomUUID();
  enrichRequestContext({ runId });
  await dispatchMatchedWorkflow({
    info: args.info,
    deps: args.deps,
    bundle: args.sourceBundle,
    payload: args.payload,
    repoIdentifier: args.sourceRepoIdentifier,
    workflowRepoIdentifier: reg.repoIdentifier,
    credentials: args.sourceCredentials,
    event: args.event,
    eventWithFiles: args.eventWithFiles,
    ref: args.ref,
    fullLockFile: globalRunLockFile(workflow, reg),
    resolvedOrgId: args.resolvedOrgId,
    workflow,
    decision: decisionOf(args.resolved.candidate),
    runId,
    trustResolution: args.trustResolution,
    lockFileSource: undefined,
    localWorkingTree: false,
    crossSource: false,
    securityDecision: args.securityDecision,
    ...(args.sourceRoutingKey !== undefined && {
      effectiveRoutingKey: args.sourceRoutingKey,
      effectiveProvider: args.sourceBundle.normalizer.provider,
    }),
    global: {
      workflowRepoIdentifier: reg.repoIdentifier,
      workflowSha: reg.commitSha,
      workflowBranch: reg.defaultBranch,
      workflowRoutingKey: reg.routingKey,
      workflowProviderContext: reg.providerContext,
      workflowBundle,
      workflowCredentials,
    },
  });
  return runId;
}
