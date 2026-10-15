/**
 * Server-side record of the user-cache namespacing for each dispatched job.
 *
 * The orchestrator decides `{orgId, repoId, cacheRefScope, runId}` at dispatch
 * time (lifted onto `job.dispatch`). The agent's `cache.user.*` requests carry
 * ONLY `jobId` + `key`, so the WS handler resolves the namespace from this
 * trusted store: a wire message can name a `jobId` but never influence the
 * org/repo/scope resolved for it.
 *
 * Written at dispatch, read on every `cache.user.*` request, deleted when the
 * job completes or its agent disconnects (mirroring the dispatcher's per-job
 * cleanup) so it cannot leak.
 */

import type { CacheRefScope } from '@kici-dev/engine';

export interface DispatchCacheRef {
  /** Org that owns the run — the per-tenant cache isolation boundary. Absent for sourceless deploys. */
  orgId?: string;
  /** E.g. "owner/repo" — second namespacing level. Absent for sourceless deploys. */
  repoId?: string;
  /** `shared` (trusted ref) or `isolated` (untrusted ref, per-run scope). */
  cacheRefScope?: CacheRefScope;
  /** The per-run isolation namespace for `isolated`-scope writes. */
  runId: string;
}

export class DispatchCacheRefTracker {
  private readonly refs = new Map<string, DispatchCacheRef>();

  record(jobId: string, ref: DispatchCacheRef): void {
    this.refs.set(jobId, ref);
  }

  /** `undefined` if the job was never dispatched or is already cleaned up. */
  get(jobId: string): DispatchCacheRef | undefined {
    return this.refs.get(jobId);
  }

  /** On completion or agent disconnect. */
  delete(jobId: string): void {
    this.refs.delete(jobId);
  }

  /** Test/teardown helper. */
  clear(): void {
    this.refs.clear();
  }

  /** For leak assertions in tests. */
  get size(): number {
    return this.refs.size;
  }
}
