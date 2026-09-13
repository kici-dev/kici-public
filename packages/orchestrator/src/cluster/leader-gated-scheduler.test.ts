import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeaderGatedScheduler } from './leader-gated-scheduler.js';

describe('LeaderGatedScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is not leader before onBecomeLeader', () => {
    const s = new LeaderGatedScheduler({ name: 't', intervalMs: 1000, tick: () => {} });
    expect(s.isLeader).toBe(false);
  });

  it('runs onBecomeLeader setup before starting the interval, and becomes leader', async () => {
    const order: string[] = [];
    const s = new LeaderGatedScheduler({
      name: 't',
      intervalMs: 1000,
      onBecomeLeader: async () => {
        order.push('setup');
      },
      tick: () => {
        order.push('tick');
      },
    });
    await s.onBecomeLeader();
    expect(s.isLeader).toBe(true);
    expect(order).toEqual(['setup']); // no tick yet
    vi.advanceTimersByTime(1000);
    expect(order).toEqual(['setup', 'tick']); // setup strictly before first tick
    s.stop();
  });

  it('stops ticking after onLoseLeadership', async () => {
    const tick = vi.fn();
    const s = new LeaderGatedScheduler({ name: 't', intervalMs: 1000, tick });
    await s.onBecomeLeader();
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(1);
    s.onLoseLeadership();
    expect(s.isLeader).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(tick).toHaveBeenCalledTimes(1); // no further ticks
  });

  it('stop() clears the timer and resets leader state', async () => {
    const tick = vi.fn();
    const s = new LeaderGatedScheduler({ name: 't', intervalMs: 1000, tick });
    await s.onBecomeLeader();
    s.stop();
    expect(s.isLeader).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(tick).not.toHaveBeenCalled();
  });

  it('catches and swallows a throwing tick (does not reject the interval)', async () => {
    const tick = vi.fn().mockRejectedValue(new Error('boom'));
    const s = new LeaderGatedScheduler({ name: 't', intervalMs: 1000, tick });
    await s.onBecomeLeader();
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    await Promise.resolve(); // let the rejection settle
    expect(tick).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it('catches a synchronously-throwing tick (does not escape the interval)', async () => {
    const tick = vi.fn(() => {
      throw new Error('sync boom');
    });
    const s = new LeaderGatedScheduler({ name: 't', intervalMs: 1000, tick });
    await s.onBecomeLeader();
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(tick).toHaveBeenCalledTimes(1);
    // A subsequent tick still fires — the caught throw did not clear the interval.
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(2);
    s.stop();
  });

  it('clears a stale timer if onBecomeLeader is called twice', async () => {
    const tick = vi.fn();
    const s = new LeaderGatedScheduler({ name: 't', intervalMs: 1000, tick });
    await s.onBecomeLeader();
    await s.onBecomeLeader(); // second tenure must not leave two intervals running
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it('does not start the interval when leadership is lost during the async setup', async () => {
    const tick = vi.fn();
    let releaseSetup!: () => void;
    const setupGate = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    const s = new LeaderGatedScheduler({
      name: 't',
      intervalMs: 1000,
      onBecomeLeader: () => setupGate, // stays pending until we release it
      tick,
    });

    const becoming = s.onBecomeLeader();
    // Leadership is revoked WHILE the become-leader setup is still in flight.
    s.onLoseLeadership();
    expect(s.isLeader).toBe(false);
    // Now let the async setup resolve — the interval must NOT start.
    releaseSetup();
    await becoming;

    expect(s.isLeader).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(tick).not.toHaveBeenCalled(); // no leaked timer ticking as non-leader
    s.stop();
  });

  it('runs exactly one interval when leadership is lost then regained during a pending setup', async () => {
    const tick = vi.fn();
    const gates: Array<() => void> = [];
    const s = new LeaderGatedScheduler({
      name: 't',
      intervalMs: 1000,
      onBecomeLeader: () =>
        new Promise<void>((resolve) => {
          gates.push(resolve);
        }),
      tick,
    });

    const first = s.onBecomeLeader(); // tenure 1 setup pending
    s.onLoseLeadership();
    const second = s.onBecomeLeader(); // tenure 2 setup pending

    // Resolve the stale (tenure 1) setup first — it must NOT start an interval.
    gates[0]();
    await first;
    // Then resolve the current (tenure 2) setup — it starts exactly one interval.
    gates[1]();
    await second;

    expect(s.isLeader).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(1); // exactly one timer, no orphan from tenure 1

    // stop() must clear it — no orphan ticks survive.
    s.stop();
    vi.advanceTimersByTime(5000);
    expect(tick).toHaveBeenCalledTimes(1);
  });
});
