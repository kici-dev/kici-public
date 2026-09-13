/**
 * RebootDeadlineSweep: clears expired host-reboot-pending flags.
 *
 * When a workflow's `restartHost()` step runs, the orchestrator sets a
 * `host_roster.reboot_pending_until` deadline and holds the pinned post-restart
 * job until the host completes a reboot cycle. If the host never returns by the
 * deadline, this sweep clears the stale flag. With the flag cleared and the
 * agent still gone, the held post-restart job hits the existing dispatch-queue
 * timeout and the run fails — the "host did not return after reboot" outcome.
 *
 * Driven by the leader-only host-roster reaper's tick (one timer, one leader),
 * so this class owns no timer of its own — just a testable `scan()`.
 */

import { createLogger, toErrorMessage } from '@kici-dev/shared';

const logger = createLogger({ prefix: 'reboot-deadline-sweep' });

/** Narrow roster slice the sweep needs (set on the full HostRosterStore). */
export interface RebootDeadlineRosterStore {
  /** Agent ids whose reboot-pending deadline has passed at `nowMs`. */
  listExpiredRebootPending(nowMs: number): Promise<string[]>;
  /** Clear the reboot-pending flag for an agent. */
  clearRebootPending(agentId: string): Promise<void>;
}

export class RebootDeadlineSweep {
  private readonly rosterStore: RebootDeadlineRosterStore;

  constructor(deps: { rosterStore: RebootDeadlineRosterStore }) {
    this.rosterStore = deps.rosterStore;
  }

  /** Clear every reboot-pending flag whose deadline has passed. */
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
