/**
 * Multi-context resolution helpers for the dispatch path.
 *
 * A job binds an ordered list of contexts: the workflow-level names
 * (`LockWorkflow.contexts`) first, then its own (`LockJob.contexts`). This
 * module resolves that list (dynamic elements via the agent's init job) and
 * folds per-context secrets/variables last-wins, keeping that fold out of
 * `dispatchMatchedWorkflow`, which must stay under the function-length cap.
 */
import {
  mergeOrderedMaps,
  type Context,
  type HostFacts,
  type LockJob,
  type LockWorkflow,
} from '@kici-dev/engine';
import type { SecretResolverApi } from '../secrets/secret-resolver.js';
import type { VariableStore } from '../contexts/variable-store.js';

/**
 * Persisted bound-env placeholder for a dynamic element; the agent's init eval
 * later overwrites it with the resolved name.
 */
export const DYNAMIC_ENV_PLACEHOLDER = '(dynamic)';

export interface ResolvedJobContexts {
  /** Resolved static names, in order. */
  names: string[];
  /** A dynamic element must be resolved by an agent init job. */
  needsInit: boolean;
}

/** One bound-context element, as a lock job carries it. */
export type ContextRef = NonNullable<LockJob['contexts']>[number];

/**
 * The ordered context elements a job binds: workflow-level names first, so a
 * job-level context wins a key collision.
 *
 * A workflow-level name the job also binds statically is dropped, so each
 * context is gated and resolved once, at the job's position. Every gating site
 * reads through this function, so workflow-level contexts pass the same gates.
 */
export function effectiveContextRefs(
  workflow: Pick<LockWorkflow, 'contexts'>,
  job: Pick<LockJob, 'contexts'>,
): ContextRef[] {
  const own = job.contexts ?? [];
  const ownStatic = new Set(own.filter((e) => !e.dynamic).map((e) => e.value));
  const inherited = [...new Set(workflow.contexts ?? [])]
    .filter((name) => !ownStatic.has(name))
    .map((value) => ({ value, dynamic: false }));
  return [...inherited, ...own];
}

/** Static elements use their value verbatim; a dynamic element flags `needsInit`. */
export function resolveJobContextNames(
  workflow: Pick<LockWorkflow, 'contexts'>,
  lockJob: Pick<LockJob, 'contexts'>,
): ResolvedJobContexts {
  const names: string[] = [];
  let needsInit = false;
  for (const e of effectiveContextRefs(workflow, lockJob)) {
    if (!e.dynamic) {
      names.push(e.value);
      continue;
    }
    needsInit = true;
  }
  return { names, needsInit };
}

/**
 * Build the ordered bound-context display list persisted at dispatch. Unlike
 * {@link resolveJobContextNames}, a dynamic element becomes the `(dynamic)`
 * placeholder rather than being dropped, so every declared slot is kept in order.
 */
export function buildJobContextDisplayNames(
  workflow: Pick<LockWorkflow, 'contexts'>,
  lockJob: Pick<LockJob, 'contexts'>,
): string[] {
  return effectiveContextRefs(workflow, lockJob).map((e) =>
    e.dynamic ? DYNAMIC_ENV_PLACEHOLDER : e.value,
  );
}

/** Merged secrets/variables across an ordered list of resolved contexts. */
export interface MultiEnvMergedData {
  contextVars?: Record<string, string>;
  jobSecrets?: Record<string, string>;
  jobNamespacedSecrets?: Record<string, Record<string, string>>;
}

/**
 * Resolve and fold variables + secrets across the matched contexts, last-wins
 * (longest-scope-path-wins within each context). Secrets are also returned
 * namespaced per context so qualified `<env>:<secret>` references resolve. Both
 * resolve by the matched row's id, so a glob context contributes its own row.
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
    for (const { name, env } of entries) {
      // Resolve through the matched row: for a glob context its name is the
      // pattern context's own, not the declared `name`.
      const resolved = await deps.secretResolver.resolveForContext(
        orgId,
        { id: env.id, name },
        hostCtx,
      );
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
