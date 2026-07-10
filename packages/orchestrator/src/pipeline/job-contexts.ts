/**
 * Multi-context resolution helpers for the dispatch path.
 *
 * A job binds an ordered list of contexts (`LockJob.contexts`). This
 * module resolves that list into concrete context names (static values
 * verbatim, pure-inline dynamic elements evaluated against the event) and folds
 * the per-context secrets/variables last-wins. It keeps the heavy fold logic
 * out of `dispatchMatchedWorkflow`, which must stay under the function-length cap.
 */
import {
  isLockInlineValue,
  mergeOrderedMaps,
  type Context,
  type HostFacts,
  type LockJob,
} from '@kici-dev/engine';
import type { SecretResolverApi } from '../secrets/secret-resolver.js';
import type { VariableStore } from '../contexts/variable-store.js';

/**
 * Placeholder written into the persisted bound-env list for an impure dynamic
 * element the orchestrator cannot resolve at dispatch. The agent's init eval
 * later overwrites the list with the resolved name.
 */
export const DYNAMIC_ENV_PLACEHOLDER = '(dynamic)';

/** Ordered resolved context names plus whether any element still needs agent init. */
export interface ResolvedJobContexts {
  /** Resolved static + pure-inline names, in order. */
  names: string[];
  /** True when an impure dynamic element must be resolved by an agent init job. */
  needsInit: boolean;
}

/**
 * Resolve the ordered bound-context names from a lock job. Static elements
 * use their value verbatim; pure-inline dynamic elements use the matching
 * pre-evaluated inline name (aligned by index); an impure dynamic element cannot
 * be resolved here and flags `needsInit`.
 */
export function resolveJobContextNames(
  lockJob: LockJob,
  inlineNames: ReadonlyArray<string | undefined>,
): ResolvedJobContexts {
  const names: string[] = [];
  let needsInit = false;
  const envs = lockJob.contexts ?? [];
  for (let i = 0; i < envs.length; i++) {
    const e = envs[i];
    if (!e.dynamic) {
      if (typeof e.value === 'string') names.push(e.value);
      continue;
    }
    if (isLockInlineValue(e.value)) {
      const resolved = inlineNames[i];
      if (resolved) names.push(resolved);
      else needsInit = true;
    } else {
      // Impure dynamic element — the agent's init job resolves every element.
      needsInit = true;
    }
  }
  return { names, needsInit };
}

/**
 * Build the ordered bound-context display list for persistence at dispatch.
 * Unlike {@link resolveJobContextNames}, this never drops an unresolved
 * element: a static element uses its value, a pure-inline element uses its
 * resolved name when known, and any element the orchestrator cannot resolve at
 * dispatch (impure dynamic, or an unresolved pure-inline) becomes the
 * `(dynamic)` placeholder — so the persisted column reflects every declared
 * slot in order. Returns an empty array when the job binds no context.
 */
export function buildJobContextDisplayNames(
  lockJob: LockJob,
  inlineNames: ReadonlyArray<string | undefined>,
): string[] {
  const envs = lockJob.contexts ?? [];
  return envs.map((e, i) => {
    if (!e.dynamic) return typeof e.value === 'string' ? e.value : DYNAMIC_ENV_PLACEHOLDER;
    if (isLockInlineValue(e.value)) return inlineNames[i] ?? DYNAMIC_ENV_PLACEHOLDER;
    return DYNAMIC_ENV_PLACEHOLDER;
  });
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
