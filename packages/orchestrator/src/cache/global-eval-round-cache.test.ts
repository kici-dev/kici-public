import { describe, expect, it } from 'vitest';
import {
  GlobalEvalRoundCache,
  globalEvalRoundCacheKey,
  isCacheableRoundResult,
} from './global-eval-round-cache.js';

const BASE = {
  workflowRepoIdentifier: 'org/pipelines',
  workflowSha: 'wsha',
  workflowRoutingKey: 'github:1',
  sourceRepoIdentifier: 'org/app',
  sourceSha: 'ssha',
  candidates: [{ workflowName: 'a', sourceFile: '.kici/workflows/org.ts', hasFilter: true }],
  event: { type: 'push', targetBranch: 'main' },
};

describe('globalEvalRoundCacheKey', () => {
  it('is stable across two structurally identical inputs', () => {
    // Positive control for every inequality below: the key is not simply
    // different every time it is built.
    expect(globalEvalRoundCacheKey({ ...BASE })).toBe(
      globalEvalRoundCacheKey({ ...BASE, candidates: [{ ...BASE.candidates[0] }] }),
    );
  });

  it.each([
    ['workflow repo', { workflowRepoIdentifier: 'org/other' }],
    ['workflow sha', { workflowSha: 'wsha2' }],
    ['workflow routing key', { workflowRoutingKey: 'gitlab:9' }],
    ['source repo', { sourceRepoIdentifier: 'org/other-app' }],
    ['source sha', { sourceSha: 'ssha2' }],
  ])('separates two rounds differing only in %s', (_label, override) => {
    expect(globalEvalRoundCacheKey({ ...BASE, ...override })).not.toBe(
      globalEvalRoundCacheKey(BASE),
    );
  });

  it('separates a push from a pull_request at identical shas', () => {
    // The concrete wrong-hit the sha-only key allowed: a push to `main` at
    // commit X and a PR synchronize whose head is commit X.
    expect(
      globalEvalRoundCacheKey({
        ...BASE,
        event: { type: 'pull_request', targetBranch: 'main' },
      }),
    ).not.toBe(globalEvalRoundCacheKey(BASE));
  });

  it('separates two branches pointing at one commit', () => {
    expect(
      globalEvalRoundCacheKey({ ...BASE, event: { type: 'push', targetBranch: 'release' } }),
    ).not.toBe(globalEvalRoundCacheKey(BASE));
  });

  it('separates two rounds over different candidate sets', () => {
    expect(
      globalEvalRoundCacheKey({
        ...BASE,
        candidates: [
          ...BASE.candidates,
          { workflowName: 'b', sourceFile: 'b.ts', hasFilter: false },
        ],
      }),
    ).not.toBe(globalEvalRoundCacheKey(BASE));
  });

  it('returns null rather than a partial key when the inputs cannot be serialized', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(globalEvalRoundCacheKey({ ...BASE, event: circular })).toBeNull();
  });
});

describe('isCacheableRoundResult', () => {
  it('accepts a round that decided every candidate', () => {
    expect(
      isCacheableRoundResult({
        candidates: [
          { workflowName: 'a', run: true },
          { workflowName: 'b', run: false },
        ],
      }),
    ).toBe(true);
  });

  it('rejects a round that left one candidate undecided', () => {
    // A single candidate's budget breach would otherwise be pinned for every
    // redelivery of the event, and the cache read short-circuits the round's
    // own retry.
    expect(
      isCacheableRoundResult({
        candidates: [
          { workflowName: 'a', run: true },
          { workflowName: 'b', run: false, indeterminate: true },
        ],
      }),
    ).toBe(false);
  });

  it('rejects an all-indeterminate round', () => {
    expect(
      isCacheableRoundResult({
        candidates: [
          { workflowName: 'a', run: false, indeterminate: true },
          { workflowName: 'b', run: false, indeterminate: true },
        ],
      }),
    ).toBe(false);
  });

  it('rejects an empty round', () => {
    expect(isCacheableRoundResult({ candidates: [] })).toBe(false);
  });

  it('does not throw on a malformed value', () => {
    expect(isCacheableRoundResult({} as never)).toBe(false);
    expect(isCacheableRoundResult({ candidates: 'x' } as never)).toBe(false);
  });
});

describe('GlobalEvalRoundCache', () => {
  it('stores and returns a value, counting hits and misses', () => {
    const cache = new GlobalEvalRoundCache({ max: 4 });
    const key = globalEvalRoundCacheKey(BASE)!;
    expect(cache.get(key)).toBeUndefined();
    cache.set(key, { candidates: [{ workflowName: 'a', run: true }] });
    expect(cache.get(key)?.candidates[0].run).toBe(true);
    expect(cache.stats()).toEqual({ hits: 1, misses: 1, size: 1 });
  });

  it('evicts past its entry ceiling', () => {
    const cache = new GlobalEvalRoundCache({ max: 2 });
    for (const sourceSha of ['a', 'b', 'c']) {
      cache.set(globalEvalRoundCacheKey({ ...BASE, sourceSha })!, { candidates: [] });
    }
    expect(cache.stats().size).toBe(2);
    expect(cache.get(globalEvalRoundCacheKey({ ...BASE, sourceSha: 'a' })!)).toBeUndefined();
  });
});
