/**
 * Periodic refresher for the dispatch-queue depth breakdown.
 *
 * Each tick calls {@link JobQueue.getDepthBreakdown} to refresh the queue's
 * cache and feeds {@link setDispatchQueueDepthBreakdown}, so
 * `kici_orch_dispatch_queue_depth` / `..._by_label` are recent when Prometheus
 * scrapes (the observable-gauge callback reads that synchronous cache). The
 * default 5s interval keeps data within one tick without hammering the DB.
 *
 * It also watches for sustained backpressure: pending depth at or above
 * {@link DepthRefresherOptions.thresholdGetter | threshold} for two consecutive
 * ticks emits a `logger.warn` pointing at the per-label Grafana panel. The
 * two-in-a-row guard suppresses transient spikes without a cooldown.
 *
 * The threshold is read every tick so live config reloads (SIGHUP / cluster
 * propagation) apply without a restart. `0` disables the warning; metrics keep
 * flowing.
 */
import type { Logger } from '@kici-dev/shared';
import { DispatchQueueStatus, type JobQueue } from './job-queue.js';
import { setDispatchQueueDepthBreakdown } from '../metrics/prometheus.js';
import { runDetached } from '../helpers/run-detached.js';

export interface DepthRefresherOptions {
  queue: JobQueue;
  logger: Logger;
  /**
   * Default 5 seconds, so Prometheus's default 15s scrape interval never sees
   * data older than one tick.
   */
  intervalMs?: number;
  /** Read every tick: the backpressure warn threshold. `0` disables warnings. */
  thresholdGetter: () => number;
  /** Test hook, invoked after each successful tick. */
  onTick?: (pendingDepth: number) => void;
}

export interface DepthRefresher {
  /** Idempotent. */
  start(): void;
  /** Idempotent. */
  stop(): void;
  /** Runs one refresh (used at startup and in tests). */
  refreshNow(): Promise<void>;
}

/**
 * NOT started automatically: call `start()` once the orchestrator is otherwise
 * ready, and `stop()` during shutdown to avoid leaking the interval handle.
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
          // Operators grep by `event`; `byLabel` tells them which label pool is
          // starved so they can scale the right scaler.
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
      // Never crash the orchestrator: the metric goes stale until the next
      // successful tick.
      options.logger.error('dispatch queue depth refresh failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    start() {
      if (timer) return;
      // Refresh immediately so the first scrape after startup sees real data.
      runDetached(options.logger, 'Queue depth refresh', () => tick());
      timer = setInterval(() => {
        runDetached(options.logger, 'Queue depth refresh', () => tick());
      }, intervalMs);
      // Let the process exit with the timer live (tests, shutdown edge cases).
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
