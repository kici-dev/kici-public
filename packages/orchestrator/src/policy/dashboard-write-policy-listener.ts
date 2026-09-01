/**
 * Cross-coordinator propagation of dashboard-write policy changes.
 *
 * Sister to `GenericSourcesChangeListener`
 * (`packages/orchestrator/src/webhook/generic-sources-listener.ts`), which
 * owns the `generic_sources_change` channel. This listener owns
 * `dashboard_write_policy_change` — the channel `setDashboardWritePolicy`
 * emits from inside its own write transaction.
 *
 * The problem it solves: `dashboardWritePolicyEvents` is a per-process
 * `EventEmitter`, so only the coordinator that served the `kici-admin`
 * write learned about a flip. Its siblings kept serving a stale cached map
 * from their own policy gate for up to the cache TTL, and — worse — kept
 * advertising the stale map to the control plane indefinitely, because
 * capabilities are pushed on change and on reconnect, never polled. The
 * control plane caches capabilities per orchestrator connection and resolves
 * a cluster name to whichever of its connections it finds first, so a policy
 * flip could be invisible to the dashboard for as long as the cluster stayed
 * up.
 *
 * On NOTIFY:
 *   1. Queue the affected `customer_id` (the channel payload).
 *   2. Debounce 200 ms so rapid flips coalesce into one drain pass.
 *   3. For each queued customer: drop the cached map, re-read the
 *      authoritative one from the database, and emit `'changed'` on
 *      `dashboardWritePolicyEvents`. The platform-mode boot already
 *      subscribes to that event and re-broadcasts `orch.capabilities`.
 *
 * The payload is the customer id alone: every coordinator shares one
 * orchestrator database, so re-reading is both cheap and authoritative,
 * and no wire copy of the map can go stale in flight.
 *
 * The writing coordinator receives its own NOTIFY too. That is deliberate
 * and harmless — it already emitted the event in-process, and the second
 * emit produces an identical capability broadcast.
 */

import type pg from 'pg';
import type { Kysely } from 'kysely';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { Database } from '../db/types.js';
import {
  DASHBOARD_WRITE_POLICY_CHANNEL,
  dashboardWritePolicyEvents,
  getDashboardWritePolicy,
  invalidateDashboardWritePolicyCache,
} from './dashboard-write-policy.js';

const logger = createLogger({ prefix: 'dashboard-write-policy-listener' });

export interface DashboardWritePolicyChangeListenerOptions {
  /** Raw pg pool — a dedicated PoolClient is checked out for LISTEN. */
  pool: pg.Pool;
  /** Used to re-read the authoritative policy map on each NOTIFY. */
  db: Kysely<Database>;
  /** Coalesce window for rapid NOTIFYs against the same customer. Default 200 ms. */
  debounceMs?: number;
}

export class DashboardWritePolicyChangeListener {
  private client: pg.PoolClient | null = null;
  private readonly pending = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;

  constructor(private readonly opts: DashboardWritePolicyChangeListenerOptions) {
    this.debounceMs = opts.debounceMs ?? 200;
  }

  /** Open the dedicated client and subscribe. */
  async start(): Promise<void> {
    this.client = await this.opts.pool.connect();
    this.client.on('notification', (msg) => {
      if (msg.channel !== DASHBOARD_WRITE_POLICY_CHANNEL) return;
      const customerId = msg.payload ?? '';
      if (!customerId) {
        logger.warn(`${DASHBOARD_WRITE_POLICY_CHANNEL} NOTIFY missing payload`);
        return;
      }
      this.pending.add(customerId);
      this.scheduleDrain();
    });
    await this.client.query(`LISTEN ${DASHBOARD_WRITE_POLICY_CHANNEL}`);
    logger.info(`Listening for dashboard-write policy changes (debounce: ${this.debounceMs}ms)`);
  }

  async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.client) {
      try {
        await this.client.query(`UNLISTEN ${DASHBOARD_WRITE_POLICY_CHANNEL}`);
      } catch {
        // Connection may already be closed during shutdown.
      }
      this.client.release();
      this.client = null;
    }
  }

  private scheduleDrain(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.drain().catch((err) => {
        logger.error('Failed to drain dashboard-write policy change queue', {
          error: toErrorMessage(err),
        });
      });
    }, this.debounceMs);
  }

  /** Visible for tests — drain the queued customer ids synchronously. */
  async drain(): Promise<void> {
    const customerIds = Array.from(this.pending);
    this.pending.clear();
    for (const customerId of customerIds) {
      try {
        invalidateDashboardWritePolicyCache(customerId);
        const policy = await getDashboardWritePolicy(this.opts.db, customerId);
        dashboardWritePolicyEvents.emit('changed', { customerId, policy });
        logger.info('Applied cross-peer dashboard-write policy change', {
          customerId,
          disabledOperations: Object.keys(policy).length,
        });
      } catch (err) {
        // Leave the cache invalidated: the next read repopulates it from the
        // database, so a failed re-read degrades to a cache miss rather than
        // to a stale map.
        logger.error('Failed to apply dashboard-write policy change', {
          customerId,
          error: toErrorMessage(err),
        });
      }
    }
  }
}
