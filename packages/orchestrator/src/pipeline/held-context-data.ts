/**
 * Resolves a job's context data (variables, scoped secrets, container registry
 * credentials) at dispatch, and again when a job stored as a pending dispatch
 * context is dispatched later. A stored job keeps only what resolution needs
 * ({@link DeferredContextResolution}), never a value, and both moments merge
 * the result into the job config through {@link contextDataConfigFields}.
 */
import { z } from 'zod';
import {
  TrustTierSchema,
  type Context as EngineContext,
  type HostFacts,
  type LockJob,
  type TrustTier,
} from '@kici-dev/engine';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { ContextStore } from '../contexts/context-store.js';
import { toContext } from '../contexts/context-store.js';
import type { VariableStore } from '../contexts/variable-store.js';
import type { JobDispatchContext } from '../contexts/protection/pipeline.js';
import { containerRegistryAuthContributorStrippedTotal } from '../metrics/prometheus.js';
import type { QueuedJobInput } from '../queue/job-queue.js';
import { resolveContainerRegistryAuth } from '../scaler/resolve-container-auth.js';
import { JobSecretRefusedError, resolveJobQualifiedSecret } from '../secrets/job-secret-gate.js';
import type { SecretResolverApi } from '../secrets/secret-resolver.js';
import { isUntrustedTier } from '../security/trust-tier.js';
import { resolveMultiEnvMergedData } from './job-contexts.js';
import { warnUnboundJobContexts } from './unbound-job-context.js';

const logger = createLogger({ prefix: 'held-context-data' });

type LockContainer = NonNullable<LockJob['container']>;

/** The context data a job config carries. */
export interface ContextJobData {
  contextVars?: Record<string, string>;
  jobSecrets?: Record<string, string>;
  jobNamespacedSecrets?: Record<string, Record<string, string>>;
  containerRegistryAuth?: { username: string; password: string; serveraddress: string };
}

/** The stores context-data resolution reads. */
export interface ContextDataDeps {
  contextStore?: ContextStore;
  variableStore?: VariableStore;
  secretResolver?: SecretResolverApi;
}

/** What a job's container registry credentials resolve against. */
export interface RegistryAuthInputs {
  container: LockContainer;
  /** The dispatch facts the named context's protection rules evaluate. */
  dispatchCtx: JobDispatchContext;
  trustTier?: TrustTier;
  /** Contexts already admitted to this job, whose rules are not re-run. */
  admittedContextIds?: ReadonlySet<string>;
  /**
   * `omit`: a refusal (a context that does not admit the run, a missing
   * secret, a malformed reference) leaves the job without registry
   * credentials, as dispatch does. Only a store or resolver failure throws.
   * `throw` (default): every failure throws, for a caller that catches.
   */
  onRefusal?: 'throw' | 'omit';
}

/**
 * Stored with a job's pending dispatch context: everything resolution at its
 * later dispatch needs, and no secret value.
 */
export const DeferredContextResolutionSchema = z.object({
  /**
   * The contexts that admitted the job's reject rules, in merge order. The id
   * pins each one: a context deleted, or recreated under the same name, while
   * the job waits fails the release instead of resolving another context.
   */
  contexts: z.array(z.object({ name: z.string(), id: z.string() })).min(1),
  orgId: z.string(),
  /**
   * Whether the dispatch that stored the job had a secret resolver. `false`
   * resolves variables only, as that dispatch would have; absent reads as
   * `true`, so a record that predates the field still requires secrets.
   */
  resolvesSecrets: z.boolean().optional(),
  /** Routing key whose variable source overrides apply. */
  routingKey: z.string().optional(),
  hostCtx: z
    .object({ agentId: z.string(), host: z.string(), labels: z.array(z.string()) })
    .optional(),
  registryAuth: z
    .object({
      container: z.custom<LockContainer>((v) => typeof v === 'object' && v !== null),
      dispatchCtx: z.object({
        branch: z.string(),
        triggerType: z.string(),
        repository: z.string(),
        runId: z.string(),
        jobId: z.string(),
        internallyTriggered: z.boolean().optional(),
      }),
      trustTier: TrustTierSchema.optional(),
    })
    .optional(),
});
export type DeferredContextResolution = z.infer<typeof DeferredContextResolutionSchema>;

/** Identity fields for log lines. */
interface LogFields {
  runId: string;
  workflow: string;
  job: string;
}

/**
 * Resolve the merged variables and secrets of `entries`, then the container
 * registry credentials, writing each onto `into` as soon as it resolves. A
 * context that has no scope binding is named in a warning log line.
 *
 * Writing progressively keeps what already resolved when a later step throws,
 * which is what the dispatch path's catch relies on.
 */
export async function resolveContextJobData(args: {
  deps: ContextDataDeps;
  orgId: string;
  entries: ReadonlyArray<{ name: string; env: EngineContext }>;
  hostCtx?: HostFacts;
  routingKey?: string;
  registryAuth?: RegistryAuthInputs;
  log: LogFields;
  into: ContextJobData;
}): Promise<void> {
  const { deps, orgId, entries, hostCtx, routingKey, registryAuth, log, into } = args;
  const merged = await resolveMultiEnvMergedData({
    deps: { variableStore: deps.variableStore, secretResolver: deps.secretResolver },
    orgId,
    entries,
    hostCtx,
    routingKey,
  });
  if (merged.contextVars) into.contextVars = merged.contextVars;
  if (merged.jobSecrets) into.jobSecrets = merged.jobSecrets;
  if (merged.jobNamespacedSecrets) into.jobNamespacedSecrets = merged.jobNamespacedSecrets;
  await warnUnboundJobContexts({
    secretResolver: deps.secretResolver,
    orgId,
    entries,
    resolvedByName: merged.jobNamespacedSecrets,
    log,
  });

  if (registryAuth) await resolveRegistryAuthInto({ deps, orgId, registryAuth, log, into });
}

/**
 * Resolve the container registry credentials onto `into`. See
 * {@link RegistryAuthInputs.onRefusal} for which failures throw.
 */
async function resolveRegistryAuthInto(args: {
  deps: ContextDataDeps;
  orgId: string;
  registryAuth: RegistryAuthInputs;
  log: LogFields;
  into: ContextJobData;
}): Promise<void> {
  const { deps, orgId, registryAuth, log, into } = args;
  const resolver = deps.secretResolver;
  const contextStore = deps.contextStore;
  if (!resolver || !contextStore) return;
  // Private-registry credentials for the job's container image. Resolved HERE,
  // orchestrator-side: the lock carries `<context>:<secret-name>` references and
  // the agent never resolves a secret itself. The reference names its own
  // context, so it goes through the job secret gate — which runs that context's
  // protection rules — rather than a direct lookup. The same rule
  // `gitCredentials` follows.
  //
  // Stripped when the contributor is untrusted, exactly as install secrets are
  // stripped: the pull fails naturally on the first private image and no token
  // bytes leave the orchestrator. The refs come from the base-branch lock for a
  // fork pull request, so there is no forgery here — the exposure is that the
  // resolved `{username, password}` lands in `jobConfig`, which the job's own
  // process reads.
  const { container, dispatchCtx, trustTier, admittedContextIds } = registryAuth;
  if (isUntrustedTier(trustTier)) {
    containerRegistryAuthContributorStrippedTotal.add(1, { trust_tier: trustTier ?? 'unknown' });
    logger.info('Container registry auth withheld from an untrusted contributor', {
      ...log,
      trustTier: trustTier ?? 'unknown',
    });
    return;
  }
  // The AUTH resolver, not the spawn resolver: a job that builds its image has
  // no spawn (the image does not exist yet) but still needs credentials for the
  // Dockerfile's own `FROM` base.
  // A failure raised by the store or the resolver itself, as opposed to a
  // refusal this job earned; only this kind throws under `omit`.
  let lookupFailure: unknown;
  try {
    into.containerRegistryAuth = await resolveContainerRegistryAuth(container, {
      resolveSecret: async (ref) => {
        const idx = ref.indexOf(':');
        if (idx <= 0) return undefined;
        try {
          return await resolveJobQualifiedSecret({
            resolver,
            contextStore,
            orgId,
            runId: dispatchCtx.runId,
            jobId: dispatchCtx.jobId,
            context: ref.slice(0, idx),
            key: ref.slice(idx + 1),
            dispatchCtx,
            trustTier,
            ...(admittedContextIds && { admittedContextIds }),
          });
        } catch (err) {
          if (!(err instanceof JobSecretRefusedError)) lookupFailure = err;
          throw err;
        }
      },
    });
  } catch (err) {
    // breaks-if-wrong: a refusal under `omit` must dispatch with the context secrets, no registry auth
    if ((registryAuth.onRefusal ?? 'throw') === 'throw' || lookupFailure !== undefined) throw err;
    logger.warn('Container registry auth refused; dispatching without it', {
      ...log,
      error: toErrorMessage(err),
    });
  }
}

/**
 * The job-config fields a job's context data maps to.
 *
 * `runWideFlatSecrets` are layered over the context secrets so a run-wide value
 * wins a key collision, and so they reach a job with no context at all.
 */
export function contextDataConfigFields(
  data: ContextJobData | undefined,
  runWideFlatSecrets: Record<string, string> | undefined,
): Record<string, unknown> {
  const secrets = { ...(data?.jobSecrets ?? {}), ...(runWideFlatSecrets ?? {}) };
  const namespacedSecrets = { ...(data?.jobNamespacedSecrets ?? {}) };
  return {
    ...(Object.keys(secrets).length > 0 && { secrets }),
    ...(Object.keys(namespacedSecrets).length > 0 && { namespacedSecrets }),
    ...(data?.containerRegistryAuth && { containerRegistryAuth: data.containerRegistryAuth }),
    ...(data?.contextVars && { contextVars: data.contextVars }),
  };
}

/** The job-config fields {@link contextDataConfigFields} writes. */
const CONTEXT_DATA_CONFIG_KEYS = [
  'secrets',
  'namespacedSecrets',
  'containerRegistryAuth',
  'contextVars',
] as const;

/**
 * A job's dispatch input with its context data removed, for storing as a
 * pending dispatch context. `runWideFlatSecrets` stay: they belong to the run,
 * not to a context, and resolution at release layers them back on top.
 */
export function withoutContextData(
  jobInput: QueuedJobInput,
  runWideFlatSecrets: Record<string, string> | undefined,
): QueuedJobInput {
  const jobConfig = { ...jobInput.jobConfig };
  for (const key of CONTEXT_DATA_CONFIG_KEYS) delete jobConfig[key];
  return {
    ...jobInput,
    jobConfig: { ...jobConfig, ...contextDataConfigFields(undefined, runWideFlatSecrets) },
  };
}

/**
 * Resolve a released job's context data and return its dispatch input with
 * that data merged into `jobConfig`.
 *
 * The job's own contexts are not re-gated: it passed their rules, or its hold
 * was released. Throws when the record is malformed, the stores are
 * unavailable, a bound context is gone or replaced, or a lookup fails, so the
 * caller fails the job rather than dispatching it without the secrets it was
 * bound to. A registry-auth refusal leaves the job without registry
 * credentials, as dispatch does.
 */
export async function resolveReleasedJobInput(args: {
  jobInput: QueuedJobInput;
  jobName: string;
  resolution: unknown;
  deps: ContextDataDeps | undefined;
}): Promise<QueuedJobInput> {
  const { jobInput, jobName } = args;
  const parsed = DeferredContextResolutionSchema.safeParse(args.resolution);
  // fails-when: the stored record lacks contexts or orgId, so resolution has nothing to run
  if (!parsed.success) {
    throw new Error(`stored context resolution is malformed: ${parsed.error.message}`);
  }
  const resolution = parsed.data;
  const deps = args.deps;
  // fails-when: a release path passes no context store, or no secret resolver for a job stored with one
  // breaks-if-wrong: a job stored by a dispatch that had no secret resolver resolves its variables only
  if (!deps?.contextStore || (resolution.resolvesSecrets !== false && !deps.secretResolver)) {
    throw new Error('context stores are unavailable on this release path');
  }
  const entries: Array<{ name: string; env: EngineContext }> = [];
  for (const { name, id } of resolution.contexts) {
    const row = await deps.contextStore.matchContext(resolution.orgId, name);
    // fails-when: the context was deleted, or recreated under the same name, while the job was held
    if (!row || row.id !== id) {
      throw new Error(`context '${name}' was removed or replaced while the job was held`);
    }
    entries.push({ name, env: toContext(row) });
  }
  const log = { runId: jobInput.runId, workflow: jobInput.workflowName, job: jobName };
  const data: ContextJobData = {};
  await resolveContextJobData({
    deps,
    orgId: resolution.orgId,
    entries,
    ...(resolution.hostCtx && { hostCtx: resolution.hostCtx }),
    ...(resolution.routingKey !== undefined && { routingKey: resolution.routingKey }),
    ...(resolution.registryAuth && {
      registryAuth: {
        ...resolution.registryAuth,
        // The held job's own name: a matrix child inherits its base's record.
        dispatchCtx: { ...resolution.registryAuth.dispatchCtx, jobId: jobName },
        // Its bound contexts already admitted it; re-running their stateless
        // reviewer or wait-timer rule would hold the approved job again.
        admittedContextIds: new Set(resolution.contexts.map((c) => c.id)),
        onRefusal: 'omit' as const,
      },
    }),
    log,
    into: data,
  });
  const jobConfig = jobInput.jobConfig as Record<string, unknown>;
  // The stored config already carries any run-wide secrets; they stay on top.
  const fields = contextDataConfigFields(
    data,
    jobConfig.secrets as Record<string, string> | undefined,
  );
  logger.info('Resolved context data for a released job', {
    ...log,
    contexts: entries.map((e) => e.name),
  });
  return { ...jobInput, jobConfig: { ...jobConfig, ...fields } };
}

/** Log a release-time resolution failure; the caller fails the job. */
export function logReleaseResolutionFailure(jobInput: QueuedJobInput, err: unknown): string {
  const message = `context data could not be resolved on release: ${toErrorMessage(err)}`;
  logger.error('Released job failed: context data resolution', {
    runId: jobInput.runId,
    workflow: jobInput.workflowName,
    job: jobInput.jobName,
    error: toErrorMessage(err),
  });
  return message;
}
