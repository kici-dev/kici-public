import { describe, it, expect, vi } from 'vitest';
import { waitForQuiesce } from './drain.js';

/** A monotonic clock that advances by `step` ms per read, starting at 0. */
function fakeClock(step = 1000): () => number {
  let t = 0;
  return () => {
    const now = t;
    t += step;
    return now;
  };
}

describe('waitForQuiesce', () => {
  it('resolves quiesced=true when jobsRunning hits 0', async () => {
    const counts = [3, 1, 0];
    const poll = vi.fn(async () => ({ draining: true, jobsRunning: counts.shift() ?? 0 }));
    const r = await waitForQuiesce(poll, {
      timeoutMs: 10_000,
      intervalMs: 0,
      now: fakeClock(),
      sleep: async () => {},
    });
    expect(r.quiesced).toBe(true);
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it('resolves quiesced=false when the timeout elapses first', async () => {
    const poll = vi.fn(async () => ({ draining: true, jobsRunning: 2 }));
    // Clock jumps past the 5ms deadline on the second read.
    const r = await waitForQuiesce(poll, {
      timeoutMs: 5,
      intervalMs: 0,
      now: fakeClock(1000),
      sleep: async () => {},
    });
    expect(r.quiesced).toBe(false);
    expect(r.jobsRunning).toBe(2);
  });
});
