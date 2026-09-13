/**
 * Tests for the periodic dispatch-queue depth refresher.
 *
 * The refresher has two responsibilities:
 *  - On every tick, refresh `setDispatchQueueDepthBreakdown` so the
 *    Prometheus observable gauge always serves fresh values.
 *  - Emit a `logger.warn` once the pending depth stays at or above
 *    the configured threshold for two consecutive ticks (~10s at the
 *    default 5s interval). Threshold `0` disables the warning entirely.
 *
 * Tests drive `refreshNow()` manually so we don't depend on real timers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createDepthRefresher } from './depth-refresher.js';
import { DispatchQueueStatus } from './job-queue.js';
import type { Logger } from '@kici-dev/shared';

function makeLogger(): Logger & {
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger & {
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

function breakdown(pending: number, dispatched = 0, byLabel: Record<string, number> = {}) {
  return {
    byStatus: {
      [DispatchQueueStatus.Pending]: pending,
      [DispatchQueueStatus.Dispatched]: dispatched,
    },
    byLabel,
  };
}

describe('createDepthRefresher', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('invokes onTick with the current pending depth on every refresh', async () => {
    const queue = { getDepthBreakdown: vi.fn().mockResolvedValue(breakdown(7, 2, { linux: 5 })) };
    const onTick = vi.fn();
    const refresher = createDepthRefresher({
      queue: queue as never,
      logger: makeLogger(),
      thresholdGetter: () => 0,
      onTick,
    });

    await refresher.refreshNow();

    expect(queue.getDepthBreakdown).toHaveBeenCalledTimes(1);
    expect(onTick).toHaveBeenCalledWith(7);
  });

  it('warns only after two consecutive over-threshold ticks (not after one)', async () => {
    const queue = { getDepthBreakdown: vi.fn().mockResolvedValue(breakdown(150)) };
    const logger = makeLogger();
    const refresher = createDepthRefresher({
      queue: queue as never,
      logger,
      thresholdGetter: () => 100,
    });

    await refresher.refreshNow();
    expect(logger.warn).not.toHaveBeenCalled();

    await refresher.refreshNow();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [msg, ctx] = logger.warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toMatch(/backpressure/i);
    expect(ctx).toMatchObject({
      event: 'queue.backpressure.sustained',
      pending: 150,
      threshold: 100,
      consecutiveTicks: 2,
    });
  });

  it('never warns when threshold=0 (warner disabled)', async () => {
    const queue = { getDepthBreakdown: vi.fn().mockResolvedValue(breakdown(10_000)) };
    const logger = makeLogger();
    const refresher = createDepthRefresher({
      queue: queue as never,
      logger,
      thresholdGetter: () => 0,
    });

    await refresher.refreshNow();
    await refresher.refreshNow();
    await refresher.refreshNow();

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('resets the consecutive-over counter when a tick drops back under threshold', async () => {
    const values = [breakdown(150), breakdown(50), breakdown(150), breakdown(150)];
    const queue = {
      getDepthBreakdown: vi.fn().mockImplementation(() => Promise.resolve(values.shift())),
    };
    const logger = makeLogger();
    const refresher = createDepthRefresher({
      queue: queue as never,
      logger,
      thresholdGetter: () => 100,
    });

    await refresher.refreshNow(); // 150 — over (#1)
    await refresher.refreshNow(); // 50 — resets to 0
    await refresher.refreshNow(); // 150 — over (#1 again)
    // No warn yet: the streak was broken.
    expect(logger.warn).not.toHaveBeenCalled();

    await refresher.refreshNow(); // 150 — over (#2), should warn.
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('logs .error and does not crash if getDepthBreakdown rejects', async () => {
    const queue = {
      getDepthBreakdown: vi.fn().mockRejectedValue(new Error('db down')),
    };
    const onTick = vi.fn();
    const logger = makeLogger();
    const refresher = createDepthRefresher({
      queue: queue as never,
      logger,
      thresholdGetter: () => 100,
      onTick,
    });

    await refresher.refreshNow();

    expect(logger.error).toHaveBeenCalledTimes(1);
    // onTick must NOT fire when the refresh failed — gauges should go stale,
    // not report stale-from-prior-state with a misleading recent timestamp.
    expect(onTick).not.toHaveBeenCalled();
  });

  it('start() is idempotent and stop() cancels the interval', async () => {
    vi.useFakeTimers();
    const queue = {
      getDepthBreakdown: vi.fn().mockResolvedValue(breakdown(0)),
    };
    const refresher = createDepthRefresher({
      queue: queue as never,
      logger: makeLogger(),
      thresholdGetter: () => 0,
      intervalMs: 100,
    });

    refresher.start();
    refresher.start(); // second call must be a no-op; only one interval runs.

    // Immediate tick + two interval ticks = 3 calls.
    await vi.advanceTimersByTimeAsync(250);
    expect(queue.getDepthBreakdown).toHaveBeenCalledTimes(3);

    refresher.stop();
    await vi.advanceTimersByTimeAsync(500);

    // No further ticks after stop.
    expect(queue.getDepthBreakdown).toHaveBeenCalledTimes(3);
  });
});
