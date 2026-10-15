/**
 * Declarative cache phase (sandbox-side): restores {@link CacheSpec}s before
 * the dependent work (a job before its steps, a step before its `run`) and
 * saves them after on an exact-key miss. Each operation is a `cache:restore` /
 * `cache:save` pseudo-step (a `step.start` + `step.complete` IPC pair, like
 * `hook:*` pseudo-steps); `step.complete` `data` carries the
 * {@link CacheOutcome} plus key / matchedKey, so the agent can feed a
 * `run.event` and the dashboard can render hit/miss/saved inline.
 */
import { CacheStepType, CacheOutcome } from '@kici-dev/engine';
import { toErrorMessage } from '@kici-dev/shared';
import type { CacheSpec, CacheApi } from '@kici-dev/sdk';
import type { RunnerToAgentMessage } from '../sandbox/ipc-protocol.js';

/** Remembered per spec key so the save phase can skip exact hits. */
export interface CacheRestoreOutcome {
  hit: boolean;
  matchedKey?: string;
}

export interface CachePhaseDeps {
  /** The same API bound to `ctx.cache`. */
  cache: CacheApi;
  /** The masked runner→agent IPC send. */
  sendIpc: (msg: RunnerToAgentMessage) => void;
  /**
   * Next pseudo-step index for `ownerStepIndex` (the owning real step, or
   * {@link JOB_CACHE_OWNER}); see {@link createCacheStepIndexAllocator}.
   */
  nextStepIndex: (ownerStepIndex: number) => number;
}

/** Owner sentinel for job-level (not step-scoped) cache restore/save. */
export const JOB_CACHE_OWNER = -1;

/** Pseudo-step indices reserved per owner. */
const CACHE_INDEX_BLOCK = 1000;

/**
 * Each owner (a real step index, or {@link JOB_CACHE_OWNER}) gets a disjoint
 * block of {@link CACHE_INDEX_BLOCK} indices above every real-step and hook
 * index (`stepCount * 3 + 100`). A step's cache pseudo-step indices depend only
 * on its own owner index, so concurrently-running steps never collide.
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
 * Returns each spec key's outcome; its `matchedKey` tells the save phase
 * whether the EXACT key already exists, so it skips a redundant save.
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
 * Saves every spec whose EXACT key did not hit on restore (entries are
 * immutable). A spec restored through a `restoreKeys` prefix is still saved
 * under its exact key.
 */
export async function saveCacheSpecs(
  specs: CacheSpec[],
  restoreResults: Map<string, CacheRestoreOutcome>,
  deps: CachePhaseDeps,
  ownerStepIndex: number,
): Promise<void> {
  for (const spec of specs) {
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
