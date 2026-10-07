/**
 * Worker-mode dispatch of a job rerouted from a coordinator.
 *
 * A worker holds no provider credentials. The coordinator pre-resolves the
 * clone tokens and carries them on the `job.reroute` message. The worker keeps
 * them in the queued job's config and turns them into the agent's clone auth
 * at dispatch time.
 */
import type { JobReroute, ProviderGitAuth } from '@kici-dev/engine';
import { cloneTokenGitAuth } from '../git/clone-token-auth.js';
import { crossHostAuthRefusal } from '../git/dispatch-git-auth.js';

/**
 * Job-config keys the worker strips before the config reaches the agent: secret
 * material, the pre-resolved clone tokens, and the workflow repository's auth
 * context, which only the coordinator reads.
 */
const WORKER_PRIVATE_KEYS: ReadonlySet<string> = new Set([
  'secrets',
  'namespacedSecrets',
  'runPublicKey',
  'npmRegistries',
  'installEnvSecrets',
  'containerRegistryAuth',
  'cloneToken',
  'workflowCloneToken',
  'workflowRoutingKey',
  'workflowProviderContext',
]);

/** The queued job's config for a reroute message, carrying the pre-resolved clone tokens. */
export function rerouteJobConfig(msg: JobReroute): Record<string, unknown> {
  return {
    ...(msg.jobConfig ?? msg.payload),
    ...(msg.cloneToken && { cloneToken: msg.cloneToken }),
    ...(msg.workflowCloneToken && { workflowCloneToken: msg.workflowCloneToken }),
  };
}

/**
 * Clone auth for a rerouted job, from the clone tokens the coordinator
 * pre-resolved: the source repository's `cloneToken` becomes `sourceAuth`, and
 * an organization-wide job's `workflowCloneToken` becomes `workflowAuth`.
 */
function rerouteCloneAuth(cfg: Record<string, unknown>): {
  workflowAuth?: ProviderGitAuth;
  sourceAuth?: ProviderGitAuth;
} {
  const sourceToken = cfg.cloneToken as string | undefined;
  const workflowToken = cfg.workflowCloneToken as string | undefined;
  return {
    ...(sourceToken && { sourceAuth: cloneTokenGitAuth(sourceToken) }),
    ...(workflowToken && { workflowAuth: cloneTokenGitAuth(workflowToken) }),
  };
}

/**
 * Why a rerouted job must not reach an agent, or `undefined` when it may: a
 * global job carrying only one of its two clone tokens, whose source and
 * workflow repositories are on different git hosts. The agent would use that
 * token for the other clone, handing one host's credential to another.
 */
export function rerouteDispatchRefusal(msg: JobReroute): string | undefined {
  const cfg = rerouteJobConfig(msg);
  return crossHostAuthRefusal(cfg, msg.repoUrl ?? '', rerouteCloneAuth(cfg));
}

/** The fields of a queued job the worker dispatch reads. */
export interface WorkerQueuedJob {
  id: string;
  runId: string;
  jobName: string;
  workflowName: string;
  repoUrl: string;
  ref: string;
  sha: string;
  jobConfig: Record<string, unknown>;
}

/** The `job.dispatch` message the worker sends its agent for a rerouted job. */
export function buildWorkerDispatchMessage(
  job: WorkerQueuedJob,
  ids: { messageId: string; timestamp: number; concurrencyWaitTimeoutMs: number },
): Record<string, unknown> {
  const cfg = job.jobConfig;
  const dispatchSecrets = cfg.secrets as Record<string, string> | undefined;
  const dispatchNamespacedSecrets = cfg.namespacedSecrets as
    Record<string, Record<string, string>> | undefined;
  const dispatchRunPublicKey = cfg.runPublicKey as string | undefined;
  const dispatchNpmRegistries = cfg.npmRegistries as Array<Record<string, unknown>> | undefined;
  const dispatchInstallEnvSecrets = cfg.installEnvSecrets as Record<string, string> | undefined;
  const dispatchContainerRegistryAuth = cfg.containerRegistryAuth as
    { username: string; password: string; serveraddress: string } | undefined;
  const cleanJobConfig = Object.fromEntries(
    Object.entries(cfg).filter(([k]) => !WORKER_PRIVATE_KEYS.has(k)),
  );

  return {
    type: 'job.dispatch',
    messageId: ids.messageId,
    timestamp: ids.timestamp,
    runId: job.runId,
    jobId: job.id,
    jobName: job.jobName,
    workflowName: job.workflowName,
    repoUrl: job.repoUrl,
    ref: job.ref,
    sha: job.sha,
    lockFileUrl: cfg.lockFileUrl ?? '',
    jobConfig: cleanJobConfig,
    // The fleet-wide concurrency-slot wait, from the worker's pulled settings.
    concurrencyWaitTimeoutMs: ids.concurrencyWaitTimeoutMs,
    // Lift user-cache namespacing from jobConfig to top-level dispatch
    // fields so the worker's agent-WS handler resolves the cache ref from
    // the tracked dispatch (matches the coordinator dispatch path).
    ...(typeof cleanJobConfig.cacheOrgId === 'string' && {
      orgId: cleanJobConfig.cacheOrgId,
    }),
    ...(typeof cleanJobConfig.cacheRepoId === 'string' && {
      repoId: cleanJobConfig.cacheRepoId,
    }),
    ...(typeof cleanJobConfig.cacheRefScope === 'string' && {
      cacheRefScope: cleanJobConfig.cacheRefScope,
    }),
    // The coordinator pre-resolves the clone tokens and carries them in
    // jobConfig; they reach the agent as structured auth (see rerouteCloneAuth).
    ...rerouteCloneAuth(cfg),
    ...(dispatchSecrets && { secrets: dispatchSecrets }),
    ...(dispatchNamespacedSecrets && { namespacedSecrets: dispatchNamespacedSecrets }),
    ...(dispatchRunPublicKey && { runPublicKey: dispatchRunPublicKey }),
    ...(dispatchNpmRegistries &&
      dispatchNpmRegistries.length > 0 && { npmRegistries: dispatchNpmRegistries }),
    ...(dispatchInstallEnvSecrets &&
      Object.keys(dispatchInstallEnvSecrets).length > 0 && {
        installEnvSecrets: dispatchInstallEnvSecrets,
      }),
    ...(dispatchContainerRegistryAuth && {
      containerRegistryAuth: dispatchContainerRegistryAuth,
    }),
  };
}
