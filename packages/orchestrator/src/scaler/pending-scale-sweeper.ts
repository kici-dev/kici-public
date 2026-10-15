import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { runDetached } from '../helpers/run-detached.js';

const logger = createLogger({ prefix: 'pending-scale-sweeper' });

export interface PendingScaleSweeperOptions {
  /**
   * The dispatcher's `retryPendingScaleRequests` bound to the `sweep` trigger. Returns the
   * number of jobs re-driven (logged when > 0).
   */
  redrive: () => Promise<number>;
  intervalMs: number;
}

/**
 * Leader-gated periodic backstop for the scaler capacity-freed re-drive.
 *
 * `ScalerManager.onCapacityFreed` handles the common case at near-zero latency but can miss a
 * spawn that failed silently, a reservation freed on a non-leader coordinator, or a lost event.
 * Re-running the SAME `retryPendingScaleRequests` on a timer strands no pending at-capacity job
 * past one interval.
 *
 * Like `HostRosterReaper` / `EventRetryScanner`, it follows the Raft leadership callbacks with
 * one timer cleared on `stop()`; leader-only so coordinators don't each drive the same queue.
 */
export class PendingScaleSweeper {
  private readonly redrive: () => Promise<number>;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private isLeader = false;

  constructor(opts: PendingScaleSweeperOptions) {
    this.redrive = opts.redrive;
    this.intervalMs = opts.intervalMs;
  }

  onBecomeLeader(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isLeader = true;
    logger.info('Became leader, starting pending-scale sweeper', {
      intervalMs: this.intervalMs,
    });
    this.timer = setInterval(() => {
      runDetached(logger, 'Pending-scale sweeper tick', () => this.tick());
    }, this.intervalMs);
    this.timer.unref?.();
  }

  onLoseLeadership(): void {
    this.isLeader = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('Lost leadership, stopped pending-scale sweeper');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isLeader = false;
  }

  /** One sweep pass. Public for tests. Never throws (logs and keeps ticking). */
  async tick(): Promise<void> {
    if (!this.isLeader) return;
    try {
      const redriven = await this.redrive();
      if (redriven > 0) logger.info('Pending-scale sweep re-drove jobs', { redriven });
    } catch (err) {
      logger.error('pending-scale sweep tick failed', { error: toErrorMessage(err) });
    }
  }
}
