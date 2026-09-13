/**
 * The one resolution path for a job-originated qualified secret reference.
 *
 * A workflow may name a secret as `<context>:<key>` in a git credential or a
 * container-registry auth reference. Those references are resolved
 * orchestrator-side, outside the job's bound `contexts:` list — which is what
 * the published examples in `docs/user/patterns/git-credentials.md` and
 * `docs/user/container-jobs.md` do, so a bound-only rule would refuse every
 * documented use.
 *
 * Resolving outside the bindings is not the same as resolving with no
 * authorization. Three independent checks stand between a job and the value,
 * and this module is where all three run:
 *
 *   1. the reserved namespace is refused — a job may never name the
 *      orchestrator's own `__system__` org or a `__…__` scope;
 *   2. an untrusted contributor gets nothing, mirroring the install-secrets
 *      strip;
 *   3. the NAMED context's own protection rules run against this dispatch —
 *      the branch restriction, `minimumTrust`, concurrency, reviewers and wait
 *      timers the operator configured on `prod` apply to a `prod:` reference.
 *
 * The lock declaration is the fourth check and lives at the callers: the relay
 * pins the wire ref to `execution_jobs.git_credentials`, and container-registry
 * refs come from the lock by construction.
 *
 * Callers use this instead of `SecretResolverApi.resolveNamedInternal`, which
 * is the system-scoped direct lookup and applies none of the above.
 */

import type { Context as EngineContext, TrustTier } from '@kici-dev/engine';
import type { ContextStore } from '../contexts/context-store.js';
import { toContext } from '../contexts/context-store.js';
import {
  evaluateProtectionRules,
  type JobDispatchContext,
} from '../contexts/protection/pipeline.js';
import { isUntrustedTier } from '../security/trust-tier.js';
import type { SecretResolverApi } from './secret-resolver.js';

/**
 * The org id the orchestrator stores its OWN credentials under — GitHub App
 * private keys, webhook signing secrets, universal-git PATs. A job's `orgId` is
 * its `customer_id`, so a job can never legitimately present this value.
 */
export const RESERVED_ORG_ID = '__system__';

/**
 * Scopes the orchestrator reserves for itself. `__source__/<id>` and
 * `__webhook__/<id>` exist today (see `PgSecretStore.isInternalScope`); the
 * prefix is matched rather than the two literals so a namespace added later is
 * covered on arrival rather than on the next audit.
 */
const RESERVED_SCOPE_PREFIX = /^__/;

/**
 * Refuse a reference into the orchestrator's own reserved namespace.
 *
 * Today no job can reach one anyway — a job's `orgId` is its `customer_id`, so
 * `(orgId, '__source__/x')` misses. That is a consequence of two unrelated
 * constants agreeing, not a check: an org literally named `__system__`, a
 * source-scoped secret copied into a customer org, or a helper resolving under
 * a caller-supplied org would each remove it silently. Stating it makes it
 * survive those changes.
 *
 * The message names the reserved namespace, never the secret: a job that
 * guessed a scope learns only that the scope is reserved.
 */
export function assertResolvableJobScope(orgId: string, context: string): void {
  if (orgId === RESERVED_ORG_ID) {
    throw new Error(
      `Refusing a secret lookup under the reserved '${RESERVED_ORG_ID}' organisation.`,
    );
  }
  if (RESERVED_SCOPE_PREFIX.test(context)) {
    throw new Error(
      `Refusing a secret lookup in the reserved '${context}' namespace: ` +
        `contexts beginning with '__' belong to the orchestrator, not to a workflow.`,
    );
  }
}

export interface ResolveJobQualifiedSecretArgs {
  resolver: SecretResolverApi;
  contextStore: ContextStore;
  orgId: string;
  runId?: string;
  jobId?: string;
  /** The context half of the workflow's `<context>:<key>` reference. */
  context: string;
  /** The secret-name half. Never logged, never quoted back in an error. */
  key: string;
  /** The dispatch facts the protection rules evaluate against, from server truth. */
  dispatchCtx: JobDispatchContext;
  trustTier: TrustTier | undefined;
}

/**
 * Resolve one `<context>:<key>` reference on behalf of a running job.
 *
 * Throws — with a reason naming the check that refused — rather than returning
 * null, because every caller treats a miss as a hard failure and a nullable
 * return is one `??` away from becoming a silent fallback.
 */
export async function resolveJobQualifiedSecret(
  args: ResolveJobQualifiedSecretArgs,
): Promise<string> {
  const { resolver, contextStore, orgId, context, key, dispatchCtx, trustTier } = args;

  assertResolvableJobScope(orgId, context);

  if (isUntrustedTier(trustTier)) {
    throw new Error(
      `Refusing to resolve '${context}:' secrets for a run whose contributor tier is ` +
        `'${trustTier}'. Only a trusted ref may read workflow secrets.`,
    );
  }

  const row = await contextStore.matchContext(orgId, context);
  if (!row) {
    throw new Error(`Secret reference names context '${context}', which does not exist.`);
  }
  const env: EngineContext = toContext(row);

  // The job scope is the concurrency group, matching how the workflow-install
  // gate passes its env name: this path never queues on concurrency (the
  // running count is always 0 here), so the gate is exercised for its branch,
  // trust, reviewer and timer rules.
  const verdict = await evaluateProtectionRules(env, dispatchCtx, 0, context, trustTier);
  if (verdict.action !== 'pass') {
    throw new Error(
      `Context '${context}' does not admit this run (${verdict.action}): ` +
        `${verdict.reason ?? 'rejected by a protection rule'}`,
    );
  }

  const value = await resolver.resolveNamedInternal(orgId, context, key, {
    ...(args.runId ? { runId: args.runId } : {}),
    ...(args.jobId ? { jobId: args.jobId } : {}),
  });
  if (value === null) {
    throw new Error(`Secret not found: context=${context} key=${key}`);
  }
  return value;
}
