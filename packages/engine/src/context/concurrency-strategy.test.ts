import { describe, expect, it } from 'vitest';
import { ConcurrencyStrategy, DEFAULT_CONCURRENCY_STRATEGY } from './concurrency-strategy.js';

describe('ConcurrencyStrategy', () => {
  it('accepts the two supported strategies', () => {
    expect(ConcurrencyStrategy.safeParse(ConcurrencyStrategy.enum.queue).success).toBe(true);
    expect(ConcurrencyStrategy.safeParse(ConcurrencyStrategy.enum['cancel-pending']).success).toBe(
      true,
    );
  });

  it('rejects anything else', () => {
    expect(ConcurrencyStrategy.safeParse('cancel').success).toBe(false);
    expect(ConcurrencyStrategy.safeParse('').success).toBe(false);
    expect(ConcurrencyStrategy.safeParse(null).success).toBe(false);
  });

  it('exposes exactly the members every consumer derives from', () => {
    // Drift guard: the dashboard label map, the orchestrator store and aggregate,
    // and the wire schemas all derive from this enum, so adding or renaming a
    // member must break this assertion (and the dashboard label-coverage guard).
    expect(ConcurrencyStrategy.options).toEqual(['queue', 'cancel-pending']);
  });

  it('defaults to queue', () => {
    // A limit with no explicit strategy: the dashboard form, the snapshot
    // round-trip and the orchestrator aggregate must share this default, or the
    // form reads as permanently dirty.
    expect(DEFAULT_CONCURRENCY_STRATEGY).toBe(ConcurrencyStrategy.enum.queue);
  });
});
