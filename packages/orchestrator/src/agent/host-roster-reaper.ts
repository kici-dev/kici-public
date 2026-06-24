import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { HostRosterStore } from './host-roster.js';
import { RebootDeadlineSweep } from '../stale-detector/reboot-deadline-sweep.js';

const logger = createLogger({ prefix: 'host-roster-reaper' });

export interface HostRosterReaperOptions {
  store: Pick<
    HostRosterStore,
    | 'reapEphemeralPastTtl'
    | 'countStaticUnreachable'
    | 'listExpiredRebootPending'
    | 'clearRebootPending'
  >;
  ttlMs: number;
  /** Grace window for the connected-but-stale case in `countStaticUnreachable`. */
  graceMs: number;
  scanIntervalMs: number;
  /** Setter for the `kici_orch_declared_hosts_unreachable` gauge. */
  setUnreachableGauge: (value: number) => void;
}

/**
 * Leader-only host-roster reaper.
 *
 * Modeled on `EventRetryScanner`: started/stopped via the Raft leadership
 * callbacks, a single timer cleared on `stop()`. Each leader tick it:
 *
 * - DELETEs `ephemeral` host_roster rows whose `last_seen` is older than the ttl
 *   (scaled-down autoscale agents — silent GC, no alarm); and
 * - counts `static` (declared) hosts whose derived status is `unreachable` and
 *   publishes that count to the `kici_orch_declared_hosts_unreachable` gauge, so
 *   a Mimir ruler alert can page an operator when a declared box goes dark.
 *
 * `static` unreachability is read-derived by `deriveHostStatus` (no write here),
 * so the reaper never deletes a static row. Followers never run the reaper, so
 * the gauge series exists only on the leader (the alert uses `max by ()`).
 */
export class HostRosterReaper {
  private readonly store: HostRosterReaperOptions['store'];
  private readonly ttlMs: number;
  private readonly graceMs: number;
  private readonly scanIntervalMs: number;
  private readonly setUnreachableGauge: (value: number) => void;
  private readonly rebootSweep: RebootDeadlineSweep;
  private timer: ReturnType<typeof setInterval> | null = null;
  private isLeader = false;

  constructor(opts: HostRosterReaperOptions) {
    this.store = opts.store;
    this.ttlMs = opts.ttlMs;
    this.graceMs = opts.graceMs;
    this.scanIntervalMs = opts.scanIntervalMs;
    this.setUnreachableGauge = opts.setUnreachableGauge;
    this.rebootSweep = new RebootDeadlineSweep({ rosterStore: opts.store });
  }

  onBecomeLeader(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isLeader = true;
    logger.info('Became leader, starting host roster reaper', {
      ttlMs: this.ttlMs,
      scanIntervalMs: this.scanIntervalMs,
    });
    this.timer = setInterval(() => {
      this.tick().catch((err) =>
        logger.error('roster reaper tick failed', { error: toErrorMessage(err) }),
      );
    }, this.scanIntervalMs);
    this.timer.unref?.();
  }

  onLoseLeadership(): void {
    this.isLeader = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('Lost leadership, stopped host roster reaper');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isLeader = false;
  }

  /** One reap pass. Public for tests. */
  async tick(): Promise<void> {
    if (!this.isLeader) return;
    const deleted = await this.store.reapEphemeralPastTtl(this.ttlMs);
    if (deleted > 0) logger.info('Reaped expired ephemeral hosts', { deleted });

    const unreachable = await this.store.countStaticUnreachable(this.graceMs);
    this.setUnreachableGauge(unreachable);
    if (unreachable > 0) logger.warn('Declared hosts unreachable', { count: unreachable });

    // Clear any reboot-pending flag whose deadline has passed (host never
    // returned). The held post-restart job then fails via the queue timeout.
    await this.rebootSweep.scan();
  }
}
