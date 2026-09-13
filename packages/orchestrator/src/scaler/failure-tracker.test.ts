import { describe, it, expect } from 'vitest';
import { ScalerFailureTracker } from './failure-tracker.js';

describe('ScalerFailureTracker', () => {
  it('groups recent failures per backend with bound/unbound counts and last error', () => {
    const t = new ScalerFailureTracker();
    t.record({
      backendName: 'container-1',
      backendType: 'container',
      bound: true,
      detail: 'no such image A',
      timestampMs: 1_000,
    });
    t.record({
      backendName: 'container-1',
      backendType: 'container',
      bound: false,
      detail: 'no such image B',
      timestampMs: 2_000,
    });
    t.record({
      backendName: 'bare-1',
      backendType: 'bare-metal',
      bound: false,
      detail: 'spawn ENOENT',
      timestampMs: 1_500,
    });

    const map = t.recentByBackend(10_000, 5_000); // window covers all
    expect(map.get('container-1')).toEqual({
      backendType: 'container',
      boundCount: 1,
      unboundCount: 1,
      lastError: 'no such image B',
      lastAtMs: 2_000,
    });
    expect(map.get('bare-1')).toEqual({
      backendType: 'bare-metal',
      boundCount: 0,
      unboundCount: 1,
      lastError: 'spawn ENOENT',
      lastAtMs: 1_500,
    });
  });

  it('excludes records older than the window', () => {
    const t = new ScalerFailureTracker();
    t.record({
      backendName: 'c1',
      backendType: 'container',
      bound: true,
      detail: 'old',
      timestampMs: 1_000,
    });
    t.record({
      backendName: 'c1',
      backendType: 'container',
      bound: true,
      detail: 'fresh',
      timestampMs: 9_000,
    });
    // window = 5_000, now = 10_000 -> cutoff 5_000; only the 9_000 record survives
    const map = t.recentByBackend(5_000, 10_000);
    expect(map.get('c1')).toMatchObject({ boundCount: 1, lastError: 'fresh', lastAtMs: 9_000 });
  });

  it('returns an empty map when no records fall inside the window', () => {
    const t = new ScalerFailureTracker();
    t.record({
      backendName: 'c1',
      backendType: 'container',
      bound: true,
      detail: 'x',
      timestampMs: 1_000,
    });
    expect(t.recentByBackend(100, 10_000).size).toBe(0);
  });

  it('evicts the oldest records when over the cap', () => {
    const t = new ScalerFailureTracker(3); // cap = 3
    for (let i = 1; i <= 5; i++) {
      t.record({
        backendName: 'c1',
        backendType: 'container',
        bound: false,
        detail: `e${i}`,
        timestampMs: i * 1_000,
      });
    }
    // Only the last 3 (e3,e4,e5) survive; window covers them all.
    const map = t.recentByBackend(100_000, 6_000);
    expect(map.get('c1')).toMatchObject({ unboundCount: 3, lastError: 'e5', lastAtMs: 5_000 });
  });
});
