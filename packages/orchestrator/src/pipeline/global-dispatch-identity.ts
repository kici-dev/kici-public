/**
 * The workflow-repository identity of a dispatch whose workflow is defined in
 * another repository (a global workflow), and the seams that decide which
 * repository each dispatch concern reads.
 *
 * Policy — contexts, install secrets, the user-cache namespace — follows the
 * repository that defines the workflow. Checkout and the event stay with the
 * repository the event came from. For a same-repository dispatch every helper
 * collapses to the event's own values.
 */
import type { ProviderBundle } from '../provider-registry.js';
import type { WorkflowRepoProvenance } from '../reporting/execution-tracker.js';

/** The workflow repository of a run whose workflow is defined in another repository. */
export interface GlobalDispatchIdentity {
  /** `owner/repo` that defines the workflow. */
  readonly workflowRepoIdentifier: string;
  /** Commit of the registration the run executes. `null` when the registration predates commit tracking. */
  readonly workflowSha: string | null;
  /** Branch the registration was taken from (`workflow_registrations.default_branch`). */
  readonly workflowBranch: string | null;
  /** Routing key of the source that registered the workflow repository. */
  readonly workflowRoutingKey: string;
  /** Provider context (e.g. the installation) the workflow repository's credentials are minted with. */
  readonly workflowProviderContext: Record<string, unknown>;
  /** The workflow repository's provider bundle (may differ from the inbound one). */
  readonly workflowBundle: ProviderBundle | undefined;
  /** Credentials minted for the workflow repository. */
  readonly workflowCredentials: Record<string, unknown>;
}

interface IdentityCtx {
  repoIdentifier: string;
  event: { targetBranch: string };
  global?: GlobalDispatchIdentity;
}

/** Repository whose contexts, install secrets and lock the run uses. */
export function policyRepo(ctx: IdentityCtx): string {
  return ctx.global?.workflowRepoIdentifier ?? ctx.repoIdentifier;
}

/** Branch context branch rules check. A global run presents its registration's branch; `''` matches no rule. */
export function policyBranch(ctx: IdentityCtx): string {
  return ctx.global ? (ctx.global.workflowBranch ?? '') : ctx.event.targetBranch;
}

/** User-cache namespace. A global run gets its own (workflow repo, source repo) namespace. */
export function cacheRepoIdFor(ctx: IdentityCtx): string {
  return ctx.global
    ? `${ctx.global.workflowRepoIdentifier}::${ctx.repoIdentifier}`
    : ctx.repoIdentifier;
}

/**
 * Routing key whose per-source variable overrides layer over a context's
 * variables. A global run reads the workflow repository's source, so the
 * event's source cannot override the variables of a context it does not own.
 */
export function policyRoutingKey(ctx: {
  info: { routingKey: string };
  global?: GlobalDispatchIdentity;
}): string {
  return ctx.global?.workflowRoutingKey ?? ctx.info.routingKey;
}

/** Provenance recorded on the run row; `undefined` for a same-repo run. */
export function workflowRepoProvenance(ctx: IdentityCtx): WorkflowRepoProvenance | undefined {
  if (!ctx.global) return undefined;
  return {
    identifier: ctx.global.workflowRepoIdentifier,
    sha: ctx.global.workflowSha,
    branch: ctx.global.workflowBranch,
  };
}

/**
 * The dual-checkout job-config fields of a dispatch, with the workflow
 * repository's clone URL built by its own provider bundle. Empty for a
 * same-repository dispatch. Throws when the workflow bundle cannot build a
 * clone URL: a global job without a workflow-repository URL cannot run.
 */
export function globalJobConfigFor(ctx: IdentityCtx): Record<string, unknown> {
  if (!ctx.global) return {};
  const { workflowBundle, workflowRepoIdentifier } = ctx.global;
  const workflowRepoUrl = workflowBundle?.repoUrlBuilder?.buildCloneUrl(workflowRepoIdentifier);
  // fails-when: the workflow bundle is missing or has no repoUrlBuilder
  // breaks-if-wrong: a bundle that builds a URL must pass it through unchanged
  if (!workflowRepoUrl) {
    throw new Error(
      `Cannot dispatch the global workflow from ${workflowRepoIdentifier} for ${ctx.repoIdentifier}: ` +
        `the workflow repository's provider bundle cannot build a clone URL`,
    );
  }
  return globalJobConfigFields(ctx, workflowRepoUrl);
}

/** Job-config fields the agent uses for the dual checkout. */
export function globalJobConfigFields(
  ctx: IdentityCtx,
  workflowRepoUrl: string,
): Record<string, unknown> {
  if (!ctx.global) return {};
  const g = ctx.global;
  return {
    isGlobalWorkflow: true,
    workflowRepoUrl,
    workflowRef: g.workflowBranch ?? '',
    workflowSha: g.workflowSha ?? '',
    workflowRepoIdentifier: g.workflowRepoIdentifier,
    workflowRoutingKey: g.workflowRoutingKey,
    workflowProviderContext: g.workflowProviderContext,
  };
}

/**
 * The part of a {@link GlobalDispatchIdentity} a held run stores: everything
 * but the live provider bundle and the minted credentials, both of which a
 * resume re-derives from `workflowRoutingKey`. The commit, branch and provider
 * context are the ones captured when the run was held, so a resumed run
 * executes the workflow commit it was held at, not the live registration's.
 */
export type SerializableGlobalDispatchIdentity = Omit<
  GlobalDispatchIdentity,
  'workflowBundle' | 'workflowCredentials'
>;

/** The stored form of a global identity: its fields named one by one, so no live object or token rides along. */
export function toSerializableGlobalIdentity(
  g: GlobalDispatchIdentity,
): SerializableGlobalDispatchIdentity {
  return {
    workflowRepoIdentifier: g.workflowRepoIdentifier,
    workflowSha: g.workflowSha,
    workflowBranch: g.workflowBranch,
    workflowRoutingKey: g.workflowRoutingKey,
    workflowProviderContext: g.workflowProviderContext,
  };
}
