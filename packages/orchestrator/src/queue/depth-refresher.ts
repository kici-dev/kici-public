/**
 * Periodic refresher for the dispatch-queue depth breakdown.
 *
 * Runs on a fixed interval (default 5s) — short enough that the
 * Prometheus observable-gauge callback (which reads the JobQueue's
 * synchronous cache) never serves data older than one refresh tick,
 * long enough that a single orchestrator does not hammer the DB.
 *
 * Two responsibilities:
 *
 *   1. Call {@link JobQueue.getDepthBreakdown} to refresh the internal
 *      cache and feed {@link setDispatchQueueDepthBreakdown} so
 *      `kici_orch_dispatch_queue_depth` / `..._by_label` are always
 *      recent when Prometheus scrapes.
 *   2. Watch for sustained backpressure: when the pending depth stays
 *      at or above {@link RefresherOptions.thresholdGetter | threshold}
 *      for two consecutive refreshes, emit a `logger.warn` that points
 *      operators at the per-label Grafana panel. The two-in-a-row
 *      guard suppresses transient spikes without needing a cooldown.
 *
 * Threshold is resolved lazily on every tick via `thresholdGetter` so
 * live config reloads (SIGHUP / cluster propagation) take effect
 * immediately without restarting the refresher.
 *
 * A threshold of `0` disables the warning entirely — the refresher
 * still runs so metrics keep flowing.
 */
import type { Logger } from '@kici-dev/shared';
import { DispatchQueueStatus, type JobQueue } from './job-queue.js';
import { setDispatchQueueDepthBreakdown } from '../metrics/prometheus.js';

export interface DepthRefresherOptions {
  queue: JobQueue;
  logger: Logger;
  /**
   * How often to refresh the cache / evaluate the warning threshold.
   * Defaults to 5 seconds — short enough that Prometheus's default 15s
   * scrape interval never sees data older than one tick.
   */
  intervalMs?: number;
  /**
   * Called on every tick to get the current backpressure warn
   * threshold. `0` disables warnings.
   */
  thresholdGetter: () => number;
  /**
   * Optional hook invoked after each successful tick, for tests.
   */
  onTick?: (pendingDepth: number) => void;
}

export interface DepthRefresher {
  /** Start the periodic timer. Idempotent. */
  start(): void;
  /** Stop the periodic timer. Idempotent. */
  stop(): void;
  /** Run one refresh synchronously (used at startup and in tests). */
  refreshNow(): Promise<void>;
}

/**
 * Create a dispatch-queue depth refresher.
 *
 * The returned object is NOT started automatically — call `start()`
 * after the orchestrator is otherwise ready. `stop()` must be called
 * during shutdown to avoid leaking the interval handle.
 */
export function createDepthRefresher(options: DepthRefresherOptions): DepthRefresher {
  const intervalMs = options.intervalMs ?? 5_000;
  let timer: NodeJS.Timeout | null = null;
  let consecutiveOverThreshold = 0;

  async function tick(): Promise<void> {
    try {
      const breakdown = await options.queue.getDepthBreakdown();
      const pending = breakdown.byStatus[DispatchQueueStatus.Pending] ?? 0;
      const dispatched = breakdown.byStatus[DispatchQueueStatus.Dispatched] ?? 0;

      setDispatchQueueDepthBreakdown({
        byStatus: { pending, dispatched },
        byLabel: breakdown.byLabel,
      });

      const threshold = options.thresholdGetter();
      if (threshold > 0 && pending >= threshold) {
        consecutiveOverThreshold += 1;
        if (consecutiveOverThreshold >= 2) {
          // Keep the log structured: operators grep by `event` and the
          // `byLabel` field is the useful payload — it tells them which
          // label pool is starved so they can scale the right scaler.
          options.logger.warn('dispatch queue depth above backpressure threshold', {
            event: 'queue.backpressure.sustained',
            pending,
            dispatched,
            threshold,
            byLabel: breakdown.byLabel,
            consecutiveTicks: consecutiveOverThreshold,
          });
        }
      } else {
        consecutiveOverThreshold = 0;
      }

      options.onTick?.(pending);
    } catch (err) {
      // Refresher must never crash the orchestrator — the metric simply
      // goes stale until the next successful tick.
      options.logger.error('dispatch queue depth refresh failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    start() {
      if (timer) return;
      // Kick off an immediate refresh so the gauge is non-zero the moment
      // Prometheus scrapes after startup, then let the interval take over.
      void tick();
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
      // Allow process to exit even if the timer is still running (tests,
      // graceful shutdown edge cases).
      timer.unref();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      consecutiveOverThreshold = 0;
    },
    refreshNow: tick,
  };
}
