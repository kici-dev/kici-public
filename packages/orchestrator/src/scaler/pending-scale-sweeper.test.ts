import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PendingScaleSweeper } from './pending-scale-sweeper.js';

describe('PendingScaleSweeper', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts ticking on onBecomeLeader and calls redrive each interval', async () => {
    const redrive = vi.fn().mockResolvedValue(0);
    const sweeper = new PendingScaleSweeper({ redrive, intervalMs: 1000 });

    sweeper.onBecomeLeader();
    expect(redrive).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(redrive).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(redrive).toHaveBeenCalledTimes(2);

    sweeper.stop();
  });

  it('stops ticking on onLoseLeadership', async () => {
    const redrive = vi.fn().mockResolvedValue(0);
    const sweeper = new PendingScaleSweeper({ redrive, intervalMs: 1000 });

    sweeper.onBecomeLeader();
    await vi.advanceTimersByTimeAsync(1000);
    expect(redrive).toHaveBeenCalledTimes(1);

    sweeper.onLoseLeadership();
    await vi.advanceTimersByTimeAsync(5000);
    expect(redrive).toHaveBeenCalledTimes(1); // no further ticks
  });

  it('does not double-start when onBecomeLeader is called twice', async () => {
    const redrive = vi.fn().mockResolvedValue(0);
    const sweeper = new PendingScaleSweeper({ redrive, intervalMs: 1000 });

    sweeper.onBecomeLeader();
    sweeper.onBecomeLeader();
    await vi.advanceTimersByTimeAsync(1000);
    // A single interval elapsed → exactly one tick (the second start replaced
    // the first timer rather than adding a second).
    expect(redrive).toHaveBeenCalledTimes(1);

    sweeper.stop();
  });

  it('tolerates a rejecting redrive and keeps ticking', async () => {
    const redrive = vi.fn().mockRejectedValue(new Error('boom'));
    const sweeper = new PendingScaleSweeper({ redrive, intervalMs: 1000 });

    sweeper.onBecomeLeader();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(redrive).toHaveBeenCalledTimes(2); // rejection did not stop the timer

    sweeper.stop();
  });

  it('tick is a no-op when not leader', async () => {
    const redrive = vi.fn().mockResolvedValue(0);
    const sweeper = new PendingScaleSweeper({ redrive, intervalMs: 1000 });

    await sweeper.tick();
    expect(redrive).not.toHaveBeenCalled();
  });
});
