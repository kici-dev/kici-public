import { createLogger, toErrorMessage } from '@kici-dev/shared';

const defaultLogger = createLogger({ prefix: 'leader-gated-scheduler' });

type SchedulerLogger = ReturnType<typeof createLogger>;

export interface LeaderGatedSchedulerOptions {
  /** Human name for logs, e.g. "cron evaluation". */
  name: string;
  /** Interval between ticks, in ms. */
  intervalMs: number;
  /** The periodic body. Errors are caught and logged, never thrown out of the interval. */
  tick: () => Promise<void> | void;
  /**
   * Optional setup run AFTER leader=true and BEFORE the interval starts (awaited), so the first
   * tick can rely on it. Cron uses this for cache load + missed-schedule recovery.
   */
  onBecomeLeader?: () => Promise<void> | void;
  /** Whether to unref the interval timer. Default true; pass false to keep the loop alive. */
  unref?: boolean;
  /**
   * Logger for the lifecycle + tick-error lines. Pass the owning class's logger so the log
   * prefix stays that of the scheduler site; defaults to a `leader-gated-scheduler` logger.
   */
  logger?: SchedulerLogger;
}

/**
 * Raft-leader-only periodic scheduler. Encapsulates the become -> (optional async setup) ->
 * start-interval / lose -> stop lifecycle that the orchestrator's leader-gated schedulers share.
 * The interval runs only while this node is the leader.
 */
export class LeaderGatedScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private leader = false;
  private readonly logger: SchedulerLogger;
  /**
   * Monotonic tenure counter. Bumped on every leadership transition
   * (onBecomeLeader / onLoseLeadership / stop). onBecomeLeader captures its
   * tenure at entry and re-checks it after the awaited setup: if it changed
   * during the async setup, leadership was revoked (or superseded by a newer
   * tenure) mid-flight and this stale tenure must NOT start the interval — that
   * would leak a timer running tick() while no longer leader.
   */
  private generation = 0;

  constructor(private readonly opts: LeaderGatedSchedulerOptions) {
    this.logger = opts.logger ?? defaultLogger;
  }

  get isLeader(): boolean {
    return this.leader;
  }

  async onBecomeLeader(): Promise<void> {
    // Open a new tenure and capture it, so we can detect a leadership change
    // that lands while the awaited setup below is in flight.
    this.generation += 1;
    const gen = this.generation;
    // Clear any stale timer from a prior tenure (rapid leader transitions can overlap).
    this.clearTimer();
    this.leader = true;
    if (this.opts.onBecomeLeader) await this.opts.onBecomeLeader();
    if (gen !== this.generation) {
      // Leadership was lost (or superseded by a newer tenure) during the async
      // setup. Do NOT start the interval — the current leader/timer state is
      // owned by whichever transition bumped the generation, and starting here
      // would leak a timer ticking as a non-leader.
      return;
    }
    this.logger.info(`Became leader, starting ${this.opts.name}`, {
      intervalMs: this.opts.intervalMs,
    });
    this.timer = setInterval(() => {
      // Call tick synchronously (matching the original schedulers, which run their body on the
      // timer tick and only defer the rejection), catching both a sync throw and an async reject.
      try {
        const result = this.opts.tick();
        if (result instanceof Promise) {
          result.catch((err) =>
            this.logger.error(`${this.opts.name} tick failed`, { error: toErrorMessage(err) }),
          );
        }
      } catch (err) {
        this.logger.error(`${this.opts.name} tick failed`, { error: toErrorMessage(err) });
      }
    }, this.opts.intervalMs);
    if (this.opts.unref !== false) this.timer.unref?.();
  }

  onLoseLeadership(): void {
    // Bump the tenure so any onBecomeLeader still awaiting its setup sees the
    // change and skips starting the interval.
    this.generation += 1;
    this.leader = false;
    this.clearTimer();
    this.logger.info(`Lost leadership, stopped ${this.opts.name}`);
  }

  stop(): void {
    // Bump the tenure so an in-flight onBecomeLeader setup does not resurrect a
    // timer after stop().
    this.generation += 1;
    this.clearTimer();
    this.leader = false;
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
