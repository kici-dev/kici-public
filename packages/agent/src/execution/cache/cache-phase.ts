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
  /** Monotonic pseudo-step index allocator (continues after real steps + hooks). */
  nextStepIndex: () => number;
}

/**
 * Restore every spec, surfacing each as a `cache:restore` pseudo-step. Returns
 * a map keyed by spec key recording whether the EXACT key hit (so the save
 * phase can skip a redundant save of an entry that already exists).
 */
export async function restoreCacheSpecs(
  specs: CacheSpec[],
  deps: CachePhaseDeps,
): Promise<Map<string, CacheRestoreOutcome>> {
  const results = new Map<string, CacheRestoreOutcome>();
  for (const spec of specs) {
    const stepIndex = deps.nextStepIndex();
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
): Promise<void> {
  for (const spec of specs) {
    // Exact key already present (restore matched it verbatim) — nothing to do.
    if (restoreResults.get(spec.key)?.matchedKey === spec.key) continue;
    const stepIndex = deps.nextStepIndex();
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
