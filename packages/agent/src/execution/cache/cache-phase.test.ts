import { describe, it, expect, vi } from 'vitest';
import { CacheStepType, CacheOutcome } from '@kici-dev/engine';
import type { CacheApi, CacheSpec } from '@kici-dev/sdk';
import type { RunnerToAgentMessage } from '../sandbox/ipc-protocol.js';
import { restoreCacheSpecs, saveCacheSpecs } from './cache-phase.js';

/** Build a CachePhaseDeps with a spy sendIpc and a monotonic step-index allocator. */
function buildDeps(cache: CacheApi, startIndex = 100) {
  const sent: RunnerToAgentMessage[] = [];
  let idx = startIndex;
  return {
    deps: {
      cache,
      sendIpc: (msg: RunnerToAgentMessage) => sent.push(msg),
      nextStepIndex: () => idx++,
    },
    sent,
  };
}

describe('restoreCacheSpecs', () => {
  it('emits cache:restore start + complete with hit outcome on an exact key hit', async () => {
    const cache: CacheApi = {
      restore: vi.fn(async (spec: CacheSpec) => ({ hit: true, matchedKey: spec.key })),
      save: vi.fn(async () => {}),
    };
    const { deps, sent } = buildDeps(cache);
    const results = await restoreCacheSpecs([{ key: 'k1', paths: ['dist'] }], deps);

    expect(results.get('k1')).toEqual({ hit: true, matchedKey: 'k1' });

    const start = sent.find((m) => m.type === 'step.start');
    const complete = sent.find((m) => m.type === 'step.complete');
    expect(start?.type === 'step.start' && start.step_type).toBe(
      CacheStepType.enum['cache:restore'],
    );
    expect(complete?.type === 'step.complete' && complete.status).toBe('success');
    expect(complete?.type === 'step.complete' && complete.step_type).toBe(
      CacheStepType.enum['cache:restore'],
    );
    expect(complete?.type === 'step.complete' && complete.data?.cacheOutcome).toBe(
      CacheOutcome.enum.hit,
    );
  });

  it('records a miss outcome when restore does not hit', async () => {
    const cache: CacheApi = {
      restore: vi.fn(async () => ({ hit: false })),
      save: vi.fn(async () => {}),
    };
    const { deps, sent } = buildDeps(cache);
    const results = await restoreCacheSpecs([{ key: 'k1', paths: ['dist'] }], deps);
    expect(results.get('k1')?.hit).toBe(false);
    const complete = sent.find((m) => m.type === 'step.complete');
    expect(complete?.type === 'step.complete' && complete.data?.cacheOutcome).toBe(
      CacheOutcome.enum.miss,
    );
  });

  it('records an error outcome and a failed status when restore throws', async () => {
    const cache: CacheApi = {
      restore: vi.fn(async () => {
        throw new Error('boom');
      }),
      save: vi.fn(async () => {}),
    };
    const { deps, sent } = buildDeps(cache);
    const results = await restoreCacheSpecs([{ key: 'k1', paths: ['dist'] }], deps);
    expect(results.get('k1')?.hit).toBe(false);
    const complete = sent.find((m) => m.type === 'step.complete');
    expect(complete?.type === 'step.complete' && complete.status).toBe('failed');
    expect(complete?.type === 'step.complete' && complete.data?.cacheOutcome).toBe(
      CacheOutcome.enum.error,
    );
  });

  it('allocates a distinct pseudo-step index per spec', async () => {
    const cache: CacheApi = {
      restore: vi.fn(async () => ({ hit: false })),
      save: vi.fn(async () => {}),
    };
    const { deps, sent } = buildDeps(cache, 100);
    await restoreCacheSpecs(
      [
        { key: 'a', paths: ['p'] },
        { key: 'b', paths: ['q'] },
      ],
      deps,
    );
    const starts = sent.filter((m) => m.type === 'step.start');
    const indices = starts.map((m) => (m.type === 'step.start' ? m.stepIndex : -1));
    expect(indices).toEqual([100, 101]);
  });
});

describe('saveCacheSpecs', () => {
  it('skips saving a spec whose exact key already hit on restore', async () => {
    const save = vi.fn(async () => {});
    const cache: CacheApi = { restore: vi.fn(), save };
    const { deps, sent } = buildDeps(cache);
    const restoreResults = new Map([['k1', { hit: true, matchedKey: 'k1' }]]);
    await saveCacheSpecs([{ key: 'k1', paths: ['dist'] }], restoreResults, deps);
    expect(save).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('saves a spec that missed (or prefix-hit a different key) and emits saved outcome', async () => {
    const save = vi.fn(async () => {});
    const cache: CacheApi = { restore: vi.fn(), save };
    const { deps, sent } = buildDeps(cache);
    const restoreResults = new Map([['k1', { hit: true, matchedKey: 'prefix-old' }]]);
    await saveCacheSpecs([{ key: 'k1', paths: ['dist'] }], restoreResults, deps);
    expect(save).toHaveBeenCalledTimes(1);
    const start = sent.find((m) => m.type === 'step.start');
    const complete = sent.find((m) => m.type === 'step.complete');
    expect(start?.type === 'step.start' && start.step_type).toBe(CacheStepType.enum['cache:save']);
    expect(complete?.type === 'step.complete' && complete.data?.cacheOutcome).toBe(
      CacheOutcome.enum.saved,
    );
  });

  it('records an error outcome when save throws', async () => {
    const cache: CacheApi = {
      restore: vi.fn(),
      save: vi.fn(async () => {
        throw new Error('upload failed');
      }),
    };
    const { deps, sent } = buildDeps(cache);
    await saveCacheSpecs([{ key: 'k1', paths: ['dist'] }], new Map(), deps);
    const complete = sent.find((m) => m.type === 'step.complete');
    expect(complete?.type === 'step.complete' && complete.status).toBe('failed');
    expect(complete?.type === 'step.complete' && complete.data?.cacheOutcome).toBe(
      CacheOutcome.enum.error,
    );
  });
});
