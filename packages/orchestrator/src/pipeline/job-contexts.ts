/**
 * Multi-context resolution helpers for the dispatch path.
 *
 * A job binds an ordered list of contexts (`LockJob.contexts`). This
 * module resolves that list into concrete context names (static values
 * verbatim; every dynamic element is resolved by the agent's init job) and
 * folds the per-context secrets/variables last-wins. It keeps the heavy fold logic
 * out of `dispatchMatchedWorkflow`, which must stay under the function-length cap.
 */
import { mergeOrderedMaps, type Context, type HostFacts, type LockJob } from '@kici-dev/engine';
import type { SecretResolverApi } from '../secrets/secret-resolver.js';
import type { VariableStore } from '../contexts/variable-store.js';

/**
 * Placeholder written into the persisted bound-env list for a dynamic element
 * the orchestrator does not resolve at dispatch. The agent's init eval later
 * overwrites the list with the resolved name.
 */
export const DYNAMIC_ENV_PLACEHOLDER = '(dynamic)';

/** Ordered resolved context names plus whether any element still needs agent init. */
export interface ResolvedJobContexts {
  /** Resolved static names, in order. */
  names: string[];
  /** True when a dynamic element must be resolved by an agent init job. */
  needsInit: boolean;
}

/**
 * Resolve the ordered bound-context names from a lock job. Static elements
 * use their value verbatim; any dynamic element (inline or impure) is resolved
 * by the agent's init job and flags `needsInit`.
 */
export function resolveJobContextNames(lockJob: LockJob): ResolvedJobContexts {
  const names: string[] = [];
  let needsInit = false;
  for (const e of lockJob.contexts ?? []) {
    if (!e.dynamic) {
      if (typeof e.value === 'string') names.push(e.value);
      continue;
    }
    // Any dynamic element (inline or impure) is resolved by the agent init job.
    needsInit = true;
  }
  return { names, needsInit };
}

/**
 * Build the ordered bound-context display list for persistence at dispatch.
 * Unlike {@link resolveJobContextNames}, this never drops an unresolved
 * element: a static element uses its value, and any dynamic element (which the
 * orchestrator no longer resolves at dispatch) becomes the `(dynamic)`
 * placeholder — so the persisted column reflects every declared slot in order.
 * The deferred-init flow-back overwrites the placeholder once the agent
 * resolves the name. Returns an empty array when the job binds no context.
 */
export function buildJobContextDisplayNames(lockJob: LockJob): string[] {
  return (lockJob.contexts ?? []).map((e) =>
    !e.dynamic && typeof e.value === 'string' ? e.value : DYNAMIC_ENV_PLACEHOLDER,
  );
}

/** Merged secrets/variables across an ordered list of resolved contexts. */
export interface MultiEnvMergedData {
  contextVars?: Record<string, string>;
  jobSecrets?: Record<string, string>;
  jobNamespacedSecrets?: Record<string, Record<string, string>>;
}

/**
 * Resolve and fold variables + secrets across the ordered list of matched
 * contexts, last-wins. Each context is resolved with the existing
 * single-env logic (longest-scope-path-wins preserved within each context),
 * then folded in array order so a later context overrides an earlier key.
 * Secrets are also returned namespaced per context so qualified
 * `<env>:<secret>` references still resolve. `entries` carries the matched
 * `Context` for each name (in order); variables resolve by context id.
 */
export async function resolveMultiEnvMergedData(args: {
  deps: { variableStore?: VariableStore; secretResolver?: SecretResolverApi };
  orgId: string;
  entries: ReadonlyArray<{ name: string; env: Context }>;
  hostCtx?: HostFacts;
  routingKey?: string;
}): Promise<MultiEnvMergedData> {
  const { deps, orgId, entries, hostCtx, routingKey } = args;
  const out: MultiEnvMergedData = {};

  if (deps.variableStore) {
    const maps: Array<Record<string, string>> = [];
    for (const { env } of entries) {
      maps.push(await deps.variableStore.getResolvedVars(orgId, env.id, routingKey));
    }
    const vars = mergeOrderedMaps(maps);
    if (Object.keys(vars).length > 0) out.contextVars = vars;
  }

  if (deps.secretResolver) {
    const maps: Array<Record<string, string>> = [];
    const namespaced: Record<string, Record<string, string>> = {};
    for (const { name } of entries) {
      const resolved = await deps.secretResolver.resolveForJob(orgId, name, hostCtx);
      maps.push(resolved);
      if (Object.keys(resolved).length > 0) namespaced[name] = resolved;
    }
    const merged = mergeOrderedMaps(maps);
    if (Object.keys(merged).length > 0) {
      out.jobSecrets = merged;
      out.jobNamespacedSecrets = namespaced;
    }
  }

  return out;
}
