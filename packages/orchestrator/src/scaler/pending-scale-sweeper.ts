import { createLogger, toErrorMessage } from '@kici-dev/shared';

const logger = createLogger({ prefix: 'pending-scale-sweeper' });

export interface PendingScaleSweeperOptions {
  /**
   * Re-drive callback — the dispatcher's `retryPendingScaleRequests` bound to
   * the `sweep` trigger. Returns the number of jobs re-driven (logged when > 0).
   */
  redrive: () => Promise<number>;
  /** Sweep interval in milliseconds. */
  intervalMs: number;
}

/**
 * Leader-gated periodic backstop for the scaler capacity-freed re-drive.
 *
 * The capacity-freed hook (`ScalerManager.onCapacityFreed`) handles the common
 * case with near-zero latency, but it can miss edge cases: a spawn that failed
 * silently, a reservation freed on a non-leader coordinator, or a lost event.
 * This sweeper re-runs the SAME `retryPendingScaleRequests` on a timer so a
 * pending at-capacity job is never stranded past one interval.
 *
 * Modeled on `HostRosterReaper` / `EventRetryScanner`: started/stopped via the
 * Raft leadership callbacks, a single timer cleared on `stop()`. Leader-only so
 * multiple coordinators don't each drive the same queue.
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
      void this.tick();
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
