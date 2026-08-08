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
    // Drift guard. The dashboard Select builds its options from a
    // `Record<ConcurrencyStrategy, string>` label map, the orchestrator store
    // and aggregate type their fields with the inferred union, and the wire
    // schemas embed this enum. Adding or renaming a member here is a
    // deliberate vocabulary change, so it must break this assertion — and the
    // dashboard's own label-coverage guard — rather than slip through.
    expect(ConcurrencyStrategy.options).toEqual(['queue', 'cancel-pending']);
  });

  it('defaults to queue', () => {
    // A context may carry an effective limit with no explicit strategy. The
    // dashboard form, the snapshot round-trip, and the orchestrator aggregate
    // must all apply the same default or the form reads as permanently dirty.
    expect(DEFAULT_CONCURRENCY_STRATEGY).toBe(ConcurrencyStrategy.enum.queue);
  });
});
