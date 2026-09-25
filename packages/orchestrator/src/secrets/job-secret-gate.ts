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
 * Resolving outside the job's `contexts:` list is not the same as resolving with
 * no authorization. Three independent checks stand between a job and the value,
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
 * The value is then read through the secret-scope bindings of the context row
 * those rules ran against — for a name a glob context matches, the glob row —
 * the way a job's bound context secrets resolve. One deprecated fallback remains
 * (removal planned for v1.0.0): when the row matched by the exact name is not a
 * glob context and no scope bound to it carries the key, the scope named after
 * the context is read instead, and a deprecation warning is logged. A
 * glob-matched row never reads a same-named scope.
 *
 * The lock declaration is the fourth check and lives at the callers: the relay
 * pins the wire ref to `execution_jobs.git_credentials`, and container-registry
 * refs come from the lock by construction.
 *
 * Callers use this instead of `SecretResolverApi.resolveNamedInternal`, which
 * is the system-scoped direct lookup and applies none of the above.
 */

import { ContextType, type Context as EngineContext, type TrustTier } from '@kici-dev/engine';
import { createLogger } from '@kici-dev/shared';
import type { ContextStore } from '../contexts/context-store.js';
import { toContext } from '../contexts/context-store.js';
import {
  evaluateProtectionRules,
  type JobDispatchContext,
} from '../contexts/protection/pipeline.js';
import { isUntrustedTier } from '../security/trust-tier.js';
import type { SecretResolverApi, SecretResolutionAttribution } from './secret-resolver.js';

const logger = createLogger({ prefix: 'job-secret-gate' });

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
 * A refusal this module decides — a reserved namespace, an untrusted tier, a
 * context that does not exist or does not admit the run, a secret that is not
 * there. Distinct from a store or resolver failure, which propagates as-is, so
 * a caller can tell "this job may not have it" from "we could not look".
 */
export class JobSecretRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobSecretRefusedError';
  }
}

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
    throw new JobSecretRefusedError(
      `Refusing a secret lookup under the reserved '${RESERVED_ORG_ID}' organisation.`,
    );
  }
  if (RESERVED_SCOPE_PREFIX.test(context)) {
    throw new JobSecretRefusedError(
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
  /**
   * Ids of contexts whose protection rules already admitted this job. Their
   * rules are not re-run; the namespace and trust-tier refusals still apply.
   */
  admittedContextIds?: ReadonlySet<string>;
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
    throw new JobSecretRefusedError(
      `Refusing to resolve '${context}:' secrets for a run whose contributor tier is ` +
        `'${trustTier}'. Only a trusted ref may read workflow secrets.`,
    );
  }

  const row = await contextStore.matchContext(orgId, context);
  if (!row) {
    throw new JobSecretRefusedError(
      `Secret reference names context '${context}', which does not exist.`,
    );
  }
  const env: EngineContext = toContext(row);

  // The job scope is the concurrency group, matching how the workflow-install
  // gate passes its env name: this path never queues on concurrency (the
  // running count is always 0 here), so the gate is exercised for its branch,
  // trust, reviewer and timer rules.
  // A context this job was already admitted to — its gates passed, or the hold
  // they raised was released — is not re-gated: the reviewer and wait-timer
  // rules are stateless and would hold the approved job again. Matched by id,
  // so a context recreated under the same name is gated afresh.
  const admitted = args.admittedContextIds?.has(env.id) === true;
  const verdict = admitted
    ? { action: 'pass' as const }
    : await evaluateProtectionRules(env, dispatchCtx, 0, context, trustTier);
  // fails-when: an unadmitted context returns hold/wait/reject and the secret is still read
  // breaks-if-wrong: an admitted context whose rules are hold/wait must still resolve
  if (verdict.action !== 'pass') {
    throw new JobSecretRefusedError(
      `Context '${context}' does not admit this run (${verdict.action}): ` +
        `${verdict.reason ?? 'rejected by a protection rule'}`,
    );
  }

  // The row the rules just ran against, so the value comes from the context
  // the verdict is about.
  const attribution: SecretResolutionAttribution = {
    ...(args.runId ? { runId: args.runId } : {}),
    ...(args.jobId ? { jobId: args.jobId } : {}),
  };
  const values = await resolver.resolveForContext(
    orgId,
    { id: env.id, name: context },
    undefined,
    attribution,
  );
  const value = values[key] ?? (await readSameNamedContextScope(args, env, attribution));
  // fails-when: a glob-matched row reads the scope named after the reference
  // breaks-if-wrong: a key bound to the matched context, fixed or glob, must still resolve
  if (value === undefined) {
    throw new JobSecretRefusedError(
      `Secret not found: context=${context} key=${key} (no secret bound to that context carries the key)`,
    );
  }
  return value;
}

/**
 * Read `<context>:<key>` from the secret store scope named after the context,
 * for a context matched by its exact name when no scope bound to it carries the
 * key. Keeps a reference working when its secret was stored under the
 * context's name without binding that scope to the context, whether the
 * context binds no scope or binds others. Returns `undefined` for a
 * glob-matched row, and when that scope does not carry the key.
 *
 * @deprecated Removal planned for v1.0.0. Bind the scope to the context with
 * `kici-admin context bind`; the reference then resolves through the binding.
 */
async function readSameNamedContextScope(
  args: ResolveJobQualifiedSecretArgs,
  env: EngineContext,
  attribution: SecretResolutionAttribution,
): Promise<string | undefined> {
  const { resolver, orgId, context, key } = args;
  // fails-when: a glob-matched row reads the scope named after the reference
  // breaks-if-wrong: an exact-named context, bound or not, keeps resolving a key only its same-named scope carries
  if (env.type === ContextType.enum.glob || env.name !== context) return undefined;
  const value = await resolver.resolveNamedInternal(orgId, context, key, attribution);
  if (value === null) return undefined;
  logger.warn(
    'Deprecated: a secret reference read the scope named after its context, because no scope ' +
      'bound to the context carries the key; bind the scope with kici-admin context bind before v1.0.0',
    { orgId, context, runId: args.runId, jobId: args.jobId },
  );
  return value;
}
