import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostRosterReaper } from './host-roster-reaper.js';

const makeStore = () => ({
  reapEphemeralPastTtl: vi.fn().mockResolvedValue(0),
  countStaticUnreachable: vi.fn().mockResolvedValue(0),
  listExpiredRebootPending: vi.fn().mockResolvedValue([]),
  clearRebootPending: vi.fn().mockResolvedValue(undefined),
});

const makeReaper = (
  over: Partial<{
    store: ReturnType<typeof makeStore>;
    setUnreachableGauge: ReturnType<typeof vi.fn>;
  }> = {},
) =>
  new HostRosterReaper({
    store: over.store ?? makeStore(),
    ttlMs: 1000,
    graceMs: 5000,
    scanIntervalMs: 1000,
    setUnreachableGauge: over.setUnreachableGauge ?? vi.fn(),
  });

describe('HostRosterReaper', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does nothing when not leader', async () => {
    const store = makeStore();
    const setGauge = vi.fn();
    const reaper = makeReaper({ store, setUnreachableGauge: setGauge });
    await reaper.tick();
    expect(store.reapEphemeralPastTtl).not.toHaveBeenCalled();
    expect(store.countStaticUnreachable).not.toHaveBeenCalled();
    expect(setGauge).not.toHaveBeenCalled();
  });

  it('reaps on tick while leader', async () => {
    const store = makeStore();
    const reaper = new HostRosterReaper({
      store,
      ttlMs: 1234,
      graceMs: 5000,
      scanIntervalMs: 1000,
      setUnreachableGauge: vi.fn(),
    });
    reaper.onBecomeLeader();
    await reaper.tick();
    expect(store.reapEphemeralPastTtl).toHaveBeenCalledWith(1234);
    reaper.stop();
  });

  it('sets the unreachable gauge from countStaticUnreachable each tick while leader', async () => {
    const store = makeStore();
    store.countStaticUnreachable.mockResolvedValue(3);
    const setGauge = vi.fn();
    const reaper = makeReaper({ store, setUnreachableGauge: setGauge });
    reaper.onBecomeLeader();
    await reaper.tick();
    expect(store.countStaticUnreachable).toHaveBeenCalledWith(5000);
    expect(setGauge).toHaveBeenCalledWith(3);
    reaper.stop();
  });

  it('sets the gauge to 0 when no declared host is unreachable', async () => {
    const store = makeStore();
    store.countStaticUnreachable.mockResolvedValue(0);
    const setGauge = vi.fn();
    const reaper = makeReaper({ store, setUnreachableGauge: setGauge });
    reaper.onBecomeLeader();
    await reaper.tick();
    expect(setGauge).toHaveBeenCalledWith(0);
    reaper.stop();
  });

  it('clears expired reboot-pending flags on each leader tick', async () => {
    const store = makeStore();
    store.listExpiredRebootPending.mockResolvedValue(['rebooted-too-long']);
    const reaper = makeReaper({ store });
    reaper.onBecomeLeader();
    await reaper.tick();
    expect(store.listExpiredRebootPending).toHaveBeenCalled();
    expect(store.clearRebootPending).toHaveBeenCalledWith('rebooted-too-long');
    reaper.stop();
  });

  it('stops reaping after losing leadership', async () => {
    const store = makeStore();
    const setGauge = vi.fn();
    const reaper = makeReaper({ store, setUnreachableGauge: setGauge });
    reaper.onBecomeLeader();
    reaper.onLoseLeadership();
    await reaper.tick();
    expect(store.reapEphemeralPastTtl).not.toHaveBeenCalled();
    expect(setGauge).not.toHaveBeenCalled();
  });

  it('timer fires reap while leader', async () => {
    const store = makeStore();
    const reaper = new HostRosterReaper({
      store,
      ttlMs: 1000,
      graceMs: 5000,
      scanIntervalMs: 5000,
      setUnreachableGauge: vi.fn(),
    });
    reaper.onBecomeLeader();
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.reapEphemeralPastTtl).toHaveBeenCalled();
    reaper.stop();
  });
});
