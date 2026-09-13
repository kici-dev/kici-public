import { sql, type Kysely } from 'kysely';
import { createLogger, toErrorMessage } from '@kici-dev/shared';

import type { Database } from '../db/types.js';
import { LeaderGatedScheduler } from '../cluster/leader-gated-scheduler.js';
import type { EventStore } from './event-store.js';
import type { EventEmitter } from './event-emitter.js';
import type { EventRouterConfig } from './types.js';
import { sweepExpiredBatchWindows } from './batch-accumulator.js';
import { eventLeaseExpirationsTotal, setEventDlqDepth } from '../metrics/prometheus.js';

const logger = createLogger({ prefix: 'event-retry-scanner' });

interface EventRetryScannerOptions {
  db: Kysely<Database>;
  eventStore: EventStore;
  eventEmitter: EventEmitter;
  config: EventRouterConfig;
}

const DEFAULT_BATCH_LIMIT = 200;

/** Max failed runs enumerated in a single workflows_failed_batch payload. */
const BATCH_MAX_RUNS = 200;

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
  private readonly eventEmitter: EventEmitter;
  private readonly config: EventRouterConfig;

  private readonly scheduler: LeaderGatedScheduler;

  constructor(options: EventRetryScannerOptions) {
    this.db = options.db;
    this.eventStore = options.eventStore;
    this.eventEmitter = options.eventEmitter;
    this.config = options.config;
    this.scheduler = new LeaderGatedScheduler({
      name: 'event retry scanner',
      intervalMs: this.config.retryScanIntervalMs,
      logger,
      tick: () => this.tick(),
    });
  }

  onBecomeLeader(): void {
    void this.scheduler.onBecomeLeader();
  }

  onLoseLeadership(): void {
    this.scheduler.onLoseLeadership();
  }

  stop(): void {
    this.scheduler.stop();
  }

  /**
   * One scanner tick. Public for tests; not on the hot path otherwise.
   */
  async tick(): Promise<void> {
    if (!this.scheduler.isLeader) return;

    await this.processExpiredLeases();
    await this.processDueRetries();
    await this.processBatchWindows();
    await this.refreshDlqDepth();
  }

  /**
   * Sweep expired workflows_failed_batch accumulation windows and emit one
   * `__workflows_failed_batch` event per window that accumulated at least one
   * run. The emitted event flows back through the router and dispatches the
   * subscribing workflow exactly once. The run list is capped at
   * `BATCH_MAX_RUNS`; `total` carries the true count.
   */
  private async processBatchWindows(): Promise<void> {
    const swept = await sweepExpiredBatchWindows(this.db, new Date());
    for (const win of swept) {
      if (win.runs.length === 0) continue; // window opened but all runs excluded
      const runs = win.runs.slice(0, BATCH_MAX_RUNS).map((r) => ({
        runId: r.runId,
        repo: r.repoIdentifier,
        workflowName: r.workflowName,
        ...(r.failureClass && { failureClass: r.failureClass }),
        ...(r.senderUsername && { senderUsername: r.senderUsername }),
      }));
      await this.eventEmitter.emitWorkflowsFailedBatch({
        routingKey: win.routingKey,
        repo: win.repoIdentifier,
        registrationId: win.registrationId,
        total: win.runs.length,
        runs,
      });
      logger.info('Emitted workflows_failed_batch for swept window', {
        registrationId: win.registrationId,
        total: win.runs.length,
        emitted: runs.length,
      });
    }
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
