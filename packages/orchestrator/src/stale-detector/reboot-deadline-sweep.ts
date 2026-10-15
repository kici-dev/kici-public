/**
 * Clears expired host-reboot-pending flags.
 *
 * A `restartHost()` step sets `host_roster.reboot_pending_until` and holds the pinned
 * post-restart job until the host completes a reboot cycle. If the host misses the deadline,
 * this clears the flag; with the agent still gone, the held job hits the dispatch-queue timeout
 * and the run fails — the "host did not return after reboot" outcome.
 *
 * Driven by the leader-only host-roster reaper's tick (one timer, one leader), so it owns no
 * timer — just a testable `scan()`.
 */

import { createLogger, toErrorMessage } from '@kici-dev/shared';

const logger = createLogger({ prefix: 'reboot-deadline-sweep' });

/** Narrow roster slice the sweep needs (set on the full HostRosterStore). */
export interface RebootDeadlineRosterStore {
  /** Agent ids whose reboot-pending deadline has passed at `nowMs`. */
  listExpiredRebootPending(nowMs: number): Promise<string[]>;
  clearRebootPending(agentId: string): Promise<void>;
}

export class RebootDeadlineSweep {
  private readonly rosterStore: RebootDeadlineRosterStore;

  constructor(deps: { rosterStore: RebootDeadlineRosterStore }) {
    this.rosterStore = deps.rosterStore;
  }

  async scan(): Promise<void> {
    try {
      const expired = await this.rosterStore.listExpiredRebootPending(Date.now());
      for (const agentId of expired) {
        await this.rosterStore.clearRebootPending(agentId);
        logger.warn('Host did not return after reboot within deadline; cleared reboot-pending', {
          agentId,
        });
      }
    } catch (err) {
      logger.error('Reboot deadline sweep error', { error: toErrorMessage(err) });
    }
  }
}
