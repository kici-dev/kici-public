import { sql, type Kysely } from 'kysely';
import { createLogger, toErrorMessage } from '@kici-dev/shared';

import type { Database } from '../db/types.js';
import type { EventStore } from './event-store.js';
import type { EventRouterConfig } from './types.js';
import { eventLeaseExpirationsTotal, setEventDlqDepth } from '../metrics/prometheus.js';

const logger = createLogger({ prefix: 'event-retry-scanner' });

interface EventRetryScannerOptions {
  db: Kysely<Database>;
  eventStore: EventStore;
  config: EventRouterConfig;
}

const DEFAULT_BATCH_LIMIT = 200;

/**
 * Leader-only periodic scanner that closes two gaps in event delivery:
 *
 *  1. Retries: events whose `next_retry_at <= NOW()` are re-published via
 *     `pg_notify('kici_event_channel', id)` so any healthy orchestrator
 *     picks them up via the normal `LISTEN/NOTIFY` path. The receiver's
 *     `tryLeaseForProcessing` ensures only one node actually dispatches.
 *
 *  2. Lease expiry: events whose `claimed_at` is older than
 *     `leaseDurationMs` belong to a node that crashed (or hung) before
 *     finalising the dispatch. The scanner releases the lease (clears
 *     `claimed_at`, sets `next_retry_at = NOW()`) and re-publishes
 *     `pg_notify`. This is the visible signal — via
 *     `kici_orch_event_lease_expirations_total` — that a node died
 *     mid-dispatch.
 *
 * The scanner also refreshes the `kici_orch_event_dlq_depth` gauge so
 * operators can alert on DLQ growth.
 *
 * Modeled on `CronScheduler`: leader-only, started/stopped via Raft
 * leadership callbacks, single timer cleared on `stop()`.
 */
export class EventRetryScanner {
  private readonly db: Kysely<Database>;
  private readonly eventStore: EventStore;
  private readonly config: EventRouterConfig;

  private timer: ReturnType<typeof setInterval> | null = null;
  private isLeader = false;

  constructor(options: EventRetryScannerOptions) {
    this.db = options.db;
    this.eventStore = options.eventStore;
    this.config = options.config;
  }

  onBecomeLeader(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isLeader = true;
    logger.info('Became leader, starting event retry scanner', {
      retryScanIntervalMs: this.config.retryScanIntervalMs,
      leaseDurationMs: this.config.leaseDurationMs,
    });
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        logger.error('Event retry scanner tick failed', { error: toErrorMessage(err) });
      });
    }, this.config.retryScanIntervalMs);
    this.timer.unref?.();
  }

  onLoseLeadership(): void {
    this.isLeader = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('Lost leadership, stopped event retry scanner');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isLeader = false;
  }

  /**
   * One scanner tick. Public for tests; not on the hot path otherwise.
   */
  async tick(): Promise<void> {
    if (!this.isLeader) return;

    await this.processExpiredLeases();
    await this.processDueRetries();
    await this.refreshDlqDepth();
  }

  private async processExpiredLeases(): Promise<void> {
    const expired = await this.eventStore.findExpiredLeases(DEFAULT_BATCH_LIMIT);
    if (expired.length === 0) return;

    logger.warn('Releasing expired dispatch leases (likely node crash mid-dispatch)', {
      count: expired.length,
    });
    eventLeaseExpirationsTotal.add(expired.length);

    for (const event of expired) {
      await this.eventStore.releaseExpiredLease(event.id);
      await this.publishNotify(event.id);
    }
  }

  private async processDueRetries(): Promise<void> {
    const due = await this.eventStore.findEventsDueForRetry(DEFAULT_BATCH_LIMIT);
    if (due.length === 0) return;

    logger.info('Re-publishing pg_notify for events due for retry', { count: due.length });
    for (const event of due) {
      await this.publishNotify(event.id);
    }
  }

  private async refreshDlqDepth(): Promise<void> {
    try {
      const depth = await this.eventStore.countDlq();
      setEventDlqDepth(depth);
    } catch (err) {
      logger.error('Failed to refresh DLQ depth gauge', { error: toErrorMessage(err) });
    }
  }

  private async publishNotify(eventId: string): Promise<void> {
    await sql`SELECT pg_notify('kici_event_channel', ${eventId})`.execute(this.db);
  }
}
