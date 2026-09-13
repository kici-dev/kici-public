/**
 * Declarative cache phase (sandbox-side).
 *
 * Restores a list of {@link CacheSpec} before the work that depends on them
 * (a job before its steps, or a step before its `run`) and saves them after
 * (on an exact-key miss). Each operation surfaces as a `cache:restore` /
 * `cache:save` pseudo-step — a `step.start` + `step.complete` IPC pair whose
 * `step_type` comes from {@link CacheStepType} — exactly mirroring how hooks
 * render as `hook:*` pseudo-steps. The `step.complete` `data` carries the
 * {@link CacheOutcome} (plus key / matchedKey / bytes) so the agent can feed a
 * `run.event` and the dashboard can render hit/miss/saved inline.
 */
import { CacheStepType, CacheOutcome } from '@kici-dev/engine';
import { toErrorMessage } from '@kici-dev/shared';
import type { CacheSpec, CacheApi } from '@kici-dev/sdk';
import type { RunnerToAgentMessage } from '../sandbox/ipc-protocol.js';

/** The restore outcome remembered per spec key so the save phase can skip exact hits. */
export interface CacheRestoreOutcome {
  hit: boolean;
  matchedKey?: string;
}

export interface CachePhaseDeps {
  /** Imperative cache API (the same one bound to `ctx.cache`). */
  cache: CacheApi;
  /** Emit a runner→agent IPC message (the masked send). */
  sendIpc: (msg: RunnerToAgentMessage) => void;
  /**
   * Allocate the next cache pseudo-step index for `ownerStepIndex` (the real
   * step the cache op belongs to, or {@link JOB_CACHE_OWNER} for job-level
   * cache). Each owner draws from a disjoint block above every real-step and
   * hook index, so two concurrently-running steps' cache pseudo-steps never
   * collide.
   */
  nextStepIndex: (ownerStepIndex: number) => number;
}

/** Owner sentinel for job-level (not step-scoped) cache restore/save. */
export const JOB_CACHE_OWNER = -1;

/** Block size reserved per owner for cache pseudo-step indices. */
const CACHE_INDEX_BLOCK = 1000;

/**
 * Build the cache pseudo-step index allocator. Each owner (a real step index, or
 * {@link JOB_CACHE_OWNER}) gets its own disjoint block of {@link CACHE_INDEX_BLOCK}
 * indices, all above every real-step and hook index (`stepCount * 3 + 100`). A
 * step's two-or-more cache pseudo-steps are a pure function of its own owner
 * index, so concurrent children never collide. Under sequential execution the
 * emitted indices stay above all real/hook indices exactly as before.
 */
export function createCacheStepIndexAllocator(
  stepCount: number,
): (ownerStepIndex: number) => number {
  const cacheBase = stepCount * 3 + 100;
  const counters = new Map<number, number>();
  return (ownerStepIndex: number): number => {
    const n = counters.get(ownerStepIndex) ?? 0;
    counters.set(ownerStepIndex, n + 1);
    return cacheBase + (ownerStepIndex + 1) * CACHE_INDEX_BLOCK + n;
  };
}

/**
 * Restore every spec, surfacing each as a `cache:restore` pseudo-step. Returns
 * a map keyed by spec key recording whether the EXACT key hit (so the save
 * phase can skip a redundant save of an entry that already exists).
 */
export async function restoreCacheSpecs(
  specs: CacheSpec[],
  deps: CachePhaseDeps,
  ownerStepIndex: number,
): Promise<Map<string, CacheRestoreOutcome>> {
  const results = new Map<string, CacheRestoreOutcome>();
  for (const spec of specs) {
    const stepIndex = deps.nextStepIndex(ownerStepIndex);
    deps.sendIpc({
      type: 'step.start',
      stepIndex,
      stepName: `cache restore: ${spec.key}`,
      step_type: CacheStepType.enum['cache:restore'],
    });
    const start = Date.now();
    try {
      const r = await deps.cache.restore(spec);
      results.set(spec.key, { hit: r.hit, matchedKey: r.matchedKey });
      deps.sendIpc({
        type: 'step.complete',
        stepIndex,
        status: 'success',
        durationMs: Date.now() - start,
        step_type: CacheStepType.enum['cache:restore'],
        data: {
          cacheOutcome: r.hit ? CacheOutcome.enum.hit : CacheOutcome.enum.miss,
          key: spec.key,
          ...(r.matchedKey !== undefined && { matchedKey: r.matchedKey }),
        },
      });
    } catch (e) {
      results.set(spec.key, { hit: false });
      deps.sendIpc({
        type: 'step.complete',
        stepIndex,
        status: 'failed',
        durationMs: Date.now() - start,
        error: { message: toErrorMessage(e) },
        step_type: CacheStepType.enum['cache:restore'],
        data: { cacheOutcome: CacheOutcome.enum.error, key: spec.key },
      });
    }
  }
  return results;
}

/**
 * Save every spec whose EXACT key did not already hit on restore (immutable +
 * no redundant save), surfacing each as a `cache:save` pseudo-step. A spec
 * whose restore matched a different key via a `restoreKeys` prefix is still
 * saved under its exact key.
 */
export async function saveCacheSpecs(
  specs: CacheSpec[],
  restoreResults: Map<string, CacheRestoreOutcome>,
  deps: CachePhaseDeps,
  ownerStepIndex: number,
): Promise<void> {
  for (const spec of specs) {
    // Exact key already present (restore matched it verbatim) — nothing to do.
    if (restoreResults.get(spec.key)?.matchedKey === spec.key) continue;
    const stepIndex = deps.nextStepIndex(ownerStepIndex);
    deps.sendIpc({
      type: 'step.start',
      stepIndex,
      stepName: `cache save: ${spec.key}`,
      step_type: CacheStepType.enum['cache:save'],
    });
    const start = Date.now();
    try {
      await deps.cache.save(spec);
      deps.sendIpc({
        type: 'step.complete',
        stepIndex,
        status: 'success',
        durationMs: Date.now() - start,
        step_type: CacheStepType.enum['cache:save'],
        data: { cacheOutcome: CacheOutcome.enum.saved, key: spec.key },
      });
    } catch (e) {
      deps.sendIpc({
        type: 'step.complete',
        stepIndex,
        status: 'failed',
        durationMs: Date.now() - start,
        error: { message: toErrorMessage(e) },
        step_type: CacheStepType.enum['cache:save'],
        data: { cacheOutcome: CacheOutcome.enum.error, key: spec.key },
      });
    }
  }
}
