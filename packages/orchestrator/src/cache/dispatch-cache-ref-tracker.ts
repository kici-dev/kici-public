/**
 * Server-side record of the user-cache namespacing for each dispatched job.
 *
 * The user-facing cache is namespaced by `{orgId, repoId, cacheRefScope, runId}`.
 * Those values are decided by the orchestrator at dispatch time (lifted onto the
 * `job.dispatch` message). The agent later sends `cache.user.*` requests that
 * carry ONLY a `jobId` + `key` — never the namespacing — so the WS handler must
 * resolve the namespace from a trusted server-side store keyed by jobId. This
 * tracker is that store: a wire `cache.user.*` message can name a `jobId`, but it
 * can never influence the org/repo/scope the orchestrator resolves for it.
 *
 * The map is written when a job is dispatched, read on every `cache.user.*`
 * request, and deleted when the job completes or its agent disconnects (mirroring
 * the dispatcher's own per-job cleanup lifecycle) so it cannot leak.
 */

import type { CacheRefScope } from '@kici-dev/engine';

/** Cache namespacing recorded for a dispatched job. */
export interface DispatchCacheRef {
  /** Org that owns the run — the per-tenant cache isolation boundary. Absent for sourceless deploys. */
  orgId?: string;
  /** Repo identifier (e.g. "owner/repo") — second namespacing level. Absent for sourceless deploys. */
  repoId?: string;
  /** Write scope: `shared` (trusted ref) or `isolated` (untrusted ref, per-run scope). */
  cacheRefScope?: CacheRefScope;
  /** Run id — the per-run isolation namespace for `isolated`-scope writes. */
  runId: string;
}

/**
 * In-memory `jobId -> DispatchCacheRef` map populated at dispatch time and
 * consumed by the agent WS handler to resolve a `UserCacheRef` server-side.
 */
export class DispatchCacheRefTracker {
  private readonly refs = new Map<string, DispatchCacheRef>();

  /** Record the cache namespacing for a dispatched job. */
  record(jobId: string, ref: DispatchCacheRef): void {
    this.refs.set(jobId, ref);
  }

  /** Resolve the cache namespacing for a job, or `undefined` if it was never dispatched / already cleaned up. */
  get(jobId: string): DispatchCacheRef | undefined {
    return this.refs.get(jobId);
  }

  /** Drop a job's recorded ref (on completion or agent disconnect). */
  delete(jobId: string): void {
    this.refs.delete(jobId);
  }

  /** Drop every recorded ref (test/teardown helper). */
  clear(): void {
    this.refs.clear();
  }

  /** Number of currently-tracked dispatches (leak assertions in tests). */
  get size(): number {
    return this.refs.size;
  }
}
