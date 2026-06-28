import { describe, it, expect, vi } from 'vitest';
import { CacheStepType, CacheOutcome } from '@kici-dev/engine';
import type { CacheApi, CacheSpec } from '@kici-dev/sdk';
import type { RunnerToAgentMessage } from '../sandbox/ipc-protocol.js';
import {
  restoreCacheSpecs,
  saveCacheSpecs,
  createCacheStepIndexAllocator,
  JOB_CACHE_OWNER,
} from './cache-phase.js';

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
    const results = await restoreCacheSpecs([{ key: 'k1', paths: ['dist'] }], deps, 0);

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
    const results = await restoreCacheSpecs([{ key: 'k1', paths: ['dist'] }], deps, 0);
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
    const results = await restoreCacheSpecs([{ key: 'k1', paths: ['dist'] }], deps, 0);
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
      0,
    );
    const starts = sent.filter((m) => m.type === 'step.start');
    const indices = starts.map((m) => (m.type === 'step.start' ? m.stepIndex : -1));
    expect(indices).toEqual([100, 101]);
  });
});

describe('createCacheStepIndexAllocator', () => {
  it('gives each owner a disjoint, deterministic block above real/hook indices', () => {
    const alloc = createCacheStepIndexAllocator(5); // cacheBase = 5*3+100 = 115
    // Job-level owner (-1) draws its own block.
    const job0 = alloc(JOB_CACHE_OWNER);
    const job1 = alloc(JOB_CACHE_OWNER);
    expect(job1).toBe(job0 + 1); // sequential within an owner
    // Two distinct step owners never collide.
    const a0 = alloc(0);
    const a1 = alloc(0);
    const b0 = alloc(1);
    expect(a1).toBe(a0 + 1);
    expect(new Set([job0, job1, a0, a1, b0]).size).toBe(5); // all distinct
    // Every cache index clears real-step (0..4) and hook (≤ ~15) indices.
    for (const idx of [job0, job1, a0, a1, b0]) expect(idx).toBeGreaterThan(15);
  });

  it('is a pure function of the owner index (concurrent owners cannot interleave)', () => {
    const alloc = createCacheStepIndexAllocator(3);
    const owner2first = alloc(2);
    alloc(0); // an interleaved allocation for a different owner
    const owner2second = alloc(2);
    expect(owner2second).toBe(owner2first + 1); // owner 2's block is unaffected
  });
});

describe('saveCacheSpecs', () => {
  it('skips saving a spec whose exact key already hit on restore', async () => {
    const save = vi.fn(async () => {});
    const cache: CacheApi = { restore: vi.fn(), save };
    const { deps, sent } = buildDeps(cache);
    const restoreResults = new Map([['k1', { hit: true, matchedKey: 'k1' }]]);
    await saveCacheSpecs([{ key: 'k1', paths: ['dist'] }], restoreResults, deps, 0);
    expect(save).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('saves a spec that missed (or prefix-hit a different key) and emits saved outcome', async () => {
    const save = vi.fn(async () => {});
    const cache: CacheApi = { restore: vi.fn(), save };
    const { deps, sent } = buildDeps(cache);
    const restoreResults = new Map([['k1', { hit: true, matchedKey: 'prefix-old' }]]);
    await saveCacheSpecs([{ key: 'k1', paths: ['dist'] }], restoreResults, deps, 0);
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
    await saveCacheSpecs([{ key: 'k1', paths: ['dist'] }], new Map(), deps, 0);
    const complete = sent.find((m) => m.type === 'step.complete');
    expect(complete?.type === 'step.complete' && complete.status).toBe('failed');
    expect(complete?.type === 'step.complete' && complete.data?.cacheOutcome).toBe(
      CacheOutcome.enum.error,
    );
  });
});
