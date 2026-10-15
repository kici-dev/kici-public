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
  /** The owning class's logger, to keep its log prefix; defaults to `leader-gated-scheduler`. */
  logger?: SchedulerLogger;
}

/**
 * Raft-leader-only periodic scheduler: become -> (optional async setup) -> start interval;
 * lose -> stop. The interval runs only while this node is the leader. `stop()` is final: no
 * later leadership change starts another tenure.
 */
export class LeaderGatedScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private leader = false;
  private readonly logger: SchedulerLogger;
  /**
   * Monotonic tenure counter, bumped on every leadership transition (onBecomeLeader /
   * onLoseLeadership / stop). onBecomeLeader re-checks it after the awaited setup: if it
   * changed, this stale tenure must NOT start the interval, or a timer leaks running tick()
   * while no longer leader.
   */
  private generation = 0;
  /** Set by {@link stop}: no later leadership change starts another tenure. */
  private stopped = false;

  constructor(private readonly opts: LeaderGatedSchedulerOptions) {
    this.logger = opts.logger ?? defaultLogger;
  }

  get isLeader(): boolean {
    return this.leader;
  }

  async onBecomeLeader(): Promise<void> {
    if (this.stopped) return;
    this.generation += 1;
    const gen = this.generation;
    // Clear any stale timer from a prior tenure (rapid leader transitions can overlap).
    this.clearTimer();
    this.leader = true;
    if (this.opts.onBecomeLeader) await this.opts.onBecomeLeader();
    if (gen !== this.generation) {
      // Lost or superseded during setup: the transition that bumped the generation owns the
      // leader/timer state.
      return;
    }
    this.logger.info(`Became leader, starting ${this.opts.name}`, {
      intervalMs: this.opts.intervalMs,
    });
    this.timer = setInterval(() => {
      // tick runs synchronously on the timer; catch both a sync throw and an async reject.
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
    // An onBecomeLeader still awaiting its setup sees the bump and skips the interval.
    this.generation += 1;
    this.leader = false;
    this.clearTimer();
    this.logger.info(`Lost leadership, stopped ${this.opts.name}`);
  }

  stop(): void {
    this.stopped = true;
    // An in-flight onBecomeLeader setup must not resurrect a timer after stop().
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
