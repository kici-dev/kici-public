import type pg from 'pg';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/types.js';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { LockFile, SimulatedEvent, WorkflowDecision } from '@kici-dev/engine';
import { matchAllWorkflows, SCHEMA_VERSION } from '@kici-dev/engine';
import type { EventStore } from './event-store.js';
import type { EventCircuitBreaker } from './circuit-breaker.js';
import type { TrustStore } from './trust-store.js';
import type { RegistrationIndex } from '../registration/registration-index.js';
import type { EventRouterConfig, StoredEvent } from './types.js';
import {
  eventAttemptsHistogram,
  eventDispatchSuccessTotal,
  eventDlqTotal,
  eventRetryTotal,
} from '../metrics/prometheus.js';

const logger = createLogger({ prefix: 'event-router' });

/**
 * Input for emitting an internal event.
 */
export interface EmitEventInput {
  eventName: string;
  payload: Record<string, unknown>;
  sourceRepo?: string;
  sourceRoutingKey?: string;
  sourceRunId?: string;
  sourceJobId?: string;
  /** Optional cross-repo targeting: deliver only to registrations matching these repos */
  target?: { repos?: string[] };
  chainDepth?: number;
}

/**
 * Context about the registration that matched an event.
 */
export interface EventMatchContext {
  /** Routing key (e.g., "github:42") for provider resolution */
  routingKey: string;
  /** Repository identifier (e.g., "owner/repo") */
  repoIdentifier: string;
  /** Provider-specific credentials captured at registration time */
  providerContext: Record<string, unknown>;
}

export interface EventRouterOptions {
  db: Kysely<Database>;
  pool: pg.Pool;
  eventStore: EventStore;
  circuitBreaker: EventCircuitBreaker;
  trustStore: TrustStore;
  config: EventRouterConfig;
  onEventMatched: (
    event: StoredEvent,
    lockFile: LockFile,
    matchedWorkflows: WorkflowDecision[],
    context?: EventMatchContext,
  ) => Promise<void>;
  /** Registration index for DB-backed subscription matching. Events match against persistent registrations. */
  registrationIndex: RegistrationIndex;
  /** Stable identifier for this orchestrator process — written into `kici_events.claimed_by` for diagnostics. */
  nodeId: string;
}

/**
 * EventRouter delivers internal events to matching workflows via PostgreSQL LISTEN/NOTIFY.
 *
 * Follows the WebhookSecretManager pattern: raw pg.PoolClient for LISTEN,
 * Kysely for queries.
 *
 * On start, performs a catch-up scan for events missed during downtime.
 * On notification, leases the event from DB, matches against registered
 * workflows via the RegistrationIndex, and calls onEventMatched for each
 * match. Failures schedule a retry via `recordDispatchFailure`; events that
 * exhaust `maxDispatchAttempts` are moved to the DLQ via `markDlq`.
 */
export class EventRouter {
  private readonly db: Kysely<Database>;
  private readonly pool: pg.Pool;
  private readonly eventStore: EventStore;
  private readonly circuitBreaker: EventCircuitBreaker;
  private readonly trustStore: TrustStore;
  private readonly config: EventRouterConfig;
  private readonly onEventMatched: EventRouterOptions['onEventMatched'];
  private readonly registrationIndex: RegistrationIndex;
  private readonly nodeId: string;

  private client: pg.PoolClient | null = null;
  private lastProcessedEventId: string | null = null;

  constructor(options: EventRouterOptions) {
    this.db = options.db;
    this.pool = options.pool;
    this.eventStore = options.eventStore;
    this.circuitBreaker = options.circuitBreaker;
    this.trustStore = options.trustStore;
    this.config = options.config;
    this.onEventMatched = options.onEventMatched;
    this.registrationIndex = options.registrationIndex;
    this.nodeId = options.nodeId;
  }

  /**
   * Start listening for events via PostgreSQL LISTEN/NOTIFY.
   * Runs catch-up on start to process events missed during downtime.
   */
  async start(): Promise<void> {
    // Load registrations from DB on startup.
    // This ensures events can match immediately, even before the first webhook.
    await this.registrationIndex.loadFromDb();
    logger.info('Registration index loaded on startup', {
      version: this.registrationIndex.getVersion(),
    });

    this.client = await this.pool.connect();

    this.client.on('notification', (msg) => {
      if (msg.channel === 'kici_event_channel' && msg.payload) {
        this.onNotification(msg.payload).catch((err) => {
          logger.error('Failed to process event notification', {
            eventId: msg.payload,
            error: toErrorMessage(err),
          });
        });
      }
    });

    await this.client.query('LISTEN kici_event_channel');
    logger.info('LISTEN kici_event_channel active');

    // Catch-up: process events missed during downtime
    await this.catchUp();
  }

  /**
   * Stop listening and release the dedicated pg client.
   */
  async stop(): Promise<void> {
    if (this.client) {
      try {
        await this.client.query('UNLISTEN kici_event_channel');
      } catch {
        // Ignore errors during shutdown
      }
      this.client.release();
      this.client = null;
      logger.info('UNLISTEN kici_event_channel, client released');
    }
  }

  /**
   * Emit an internal event using the default DB handle.
   *
   * Wraps `emitInTx` in its own transaction. Callers that need to combine
   * the emit with other transactional work (cron-fire being the canonical
   * case) should call `emitInTx` directly with their own tx so all writes
   * commit or roll back together.
   */
  async emit(event: EmitEventInput): Promise<string> {
    return this.db.transaction().execute((tx) => this.emitInTx(event, tx));
  }

  /**
   * Emit an internal event inside a caller-provided transaction.
   *
   * Circuit-breaker checks (chain depth + rate limit) run BEFORE the
   * transaction so they fail fast without burning DB roundtrips. The
   * `kici_events` insert and the `pg_notify` are issued on the supplied
   * `tx` so they only become visible (and the notification is only
   * delivered) on commit. Postgres queues NOTIFYs issued inside a
   * transaction and releases them at COMMIT; if the tx rolls back, no
   * listener is woken — exactly what we need to make cron-fire atomic.
   */
  async emitInTx(event: EmitEventInput, tx: Transaction<Database>): Promise<string> {
    const chainDepth = event.chainDepth ?? 0;

    // Check circuit breaker -- chain depth
    const depthCheck = this.circuitBreaker.checkChainDepth(chainDepth);
    if (!depthCheck.allowed) {
      throw new Error(`Circuit breaker tripped: ${depthCheck.reason}`);
    }

    // Check circuit breaker -- rate limit (keyed by eventName)
    const rateCheck = this.circuitBreaker.checkRateLimit(event.eventName);
    if (!rateCheck.allowed) {
      throw new Error(
        `Rate limit exceeded for event '${event.eventName}'. Retry after ${rateCheck.retryAfterMs}ms`,
      );
    }

    // Persist event
    const ttlMs = this.config.eventTtlSeconds * 1000;
    const expiresAt = new Date(Date.now() + ttlMs);

    const targetRepos =
      event.target?.repos && event.target.repos.length > 0 ? event.target.repos : undefined;

    const eventId = await this.eventStore.writeWith(
      {
        eventName: event.eventName,
        payload: event.payload,
        sourceRepo: event.sourceRepo,
        sourceRoutingKey: event.sourceRoutingKey,
        sourceRunId: event.sourceRunId,
        sourceJobId: event.sourceJobId,
        targetRepos,
        chainDepth,
        expiresAt,
      },
      tx,
    );

    // Notify all listeners via pg_notify INSIDE the same transaction.
    // Postgres holds NOTIFYs until commit, so a rollback discards them.
    await sql`SELECT pg_notify('kici_event_channel', ${eventId})`.execute(tx);

    logger.info('Event emitted', {
      eventId,
      eventName: event.eventName,
      chainDepth,
      sourceRepo: event.sourceRepo,
      ...(targetRepos && { targetRepos }),
    });

    return eventId;
  }

  /**
   * Handle a LISTEN/NOTIFY notification for a new event.
   *
   * Lease-based dispatch (replaces the previous "flip processed=true upfront"
   * pattern that silently lost events when dispatch threw):
   *
   *  1. Take a dispatch lease (claimed_at + claimed_by, attempts++).
   *     Fails fast if the event is already processed, in DLQ, or held by a
   *     fresh lease on another node.
   *  2. Run dispatch. On success: markProcessed (clears lease, processed=true).
   *  3. On failure: either schedule a retry (recordDispatchFailure → leader
   *     scanner re-publishes pg_notify when next_retry_at elapses) or move
   *     to the DLQ (markDlq) when attempts exceed maxDispatchAttempts.
   *
   * If the dispatching node crashes between lease and finalisation, the
   * leader-only retry scanner releases the lease after leaseDurationMs and
   * re-publishes pg_notify so a healthy node can re-dispatch.
   */
  private async onNotification(eventId: string): Promise<void> {
    const event = await this.eventStore.tryLeaseForProcessing(eventId, this.nodeId);
    if (!event) {
      // Already processed, leased by another node, or DLQ'd.
      logger.debug('Event already leased or terminal', { eventId });
      return;
    }

    await this.dispatchAndRecord(event);
    this.lastProcessedEventId = eventId;
  }

  /**
   * Run dispatch for a leased event and record the outcome (processed,
   * retry, or DLQ). Used by both the live notification handler and the
   * catch-up loop so the failure semantics stay identical.
   */
  private async dispatchAndRecord(event: StoredEvent): Promise<void> {
    try {
      // Test-only fault injection: when this event's name maps to N in
      // `debugFailFirstNAttemptsByEvent` AND its current attempt count is
      // <= N, throw before the real dispatch runs. The thrown error rides
      // the same retry / DLQ path as a genuine dispatch failure. The map
      // is only populated when KICI_TEST_MODE=1 was set at config-load
      // time (see config/loader.ts); production never reaches this
      // branch.
      const failBudget = this.config.debugFailFirstNAttemptsByEvent?.[event.eventName];
      if (failBudget !== undefined && event.attempts <= failBudget) {
        throw new Error(
          `fault-injection: debug-fail-first-n (eventName=${event.eventName}, attempts=${event.attempts}, budget=${failBudget})`,
        );
      }
      await this.processSubscriptions(event);
      await this.eventStore.markProcessed(event.id);
      eventDispatchSuccessTotal.add(1, { event_name: event.eventName });
      eventAttemptsHistogram.record(event.attempts, {
        event_name: event.eventName,
        result: 'success',
      });
    } catch (err) {
      const errMsg = toErrorMessage(err);
      if (event.attempts >= this.config.maxDispatchAttempts) {
        await this.eventStore.markDlq(event.id, 'exhausted_retries', errMsg);
        eventDlqTotal.add(1, { event_name: event.eventName, reason: 'exhausted_retries' });
        eventAttemptsHistogram.record(event.attempts, {
          event_name: event.eventName,
          result: 'dlq',
        });
        logger.error('Event moved to DLQ after exhausting retries', {
          eventId: event.id,
          eventName: event.eventName,
          attempts: event.attempts,
          maxDispatchAttempts: this.config.maxDispatchAttempts,
          error: errMsg,
        });
      } else {
        const nextRetryAt = computeNextRetryAt(
          event.attempts,
          this.config.retryBaseBackoffMs,
          this.config.retryMaxBackoffMs,
        );
        await this.eventStore.recordDispatchFailure(event.id, errMsg, nextRetryAt);
        eventRetryTotal.add(1, { event_name: event.eventName });
        logger.warn('Event dispatch failed; scheduled for retry', {
          eventId: event.id,
          eventName: event.eventName,
          attempts: event.attempts,
          nextRetryAt: nextRetryAt.toISOString(),
          error: errMsg,
        });
      }
    }
  }

  /**
   * Match an event against all registered workflows and dispatch matches.
   *
   * Looks up registrations by trigger type via the RegistrationIndex,
   * builds per-registration lock files, and runs trigger matching against them.
   *
   * Errors propagate so the lease wrapper (`dispatchAndRecord`) can either
   * schedule a retry or move the event to the DLQ. Swallowing the error
   * here would silently lose the event — exactly the failure mode the
   * lease pattern fixes.
   */
  private async processSubscriptions(event: StoredEvent): Promise<void> {
    const simulatedEvent = this.buildSimulatedEvent(event);

    // Map stored event to trigger type for index lookup
    const triggerType = this.eventToTriggerType(event);
    let registrations = this.registrationIndex.getByEventType(triggerType);

    if (registrations.length === 0) {
      logger.debug('No registrations for event type', {
        eventId: event.id,
        eventName: event.eventName,
        triggerType,
      });
      return;
    }

    // For __schedule_fire events, the cron scheduler already targeted a specific
    // registration (via registrationId in payload). Only match against that one
    // registration to avoid N² duplication (N cron fires × N schedule registrations).
    if (event.eventName === '__schedule_fire' && event.payload.registrationId) {
      const targetId = event.payload.registrationId as string;
      registrations = registrations.filter((r) => r.id === targetId);
      if (registrations.length === 0) {
        logger.debug('Schedule fire target registration not found', {
          eventId: event.id,
          registrationId: targetId,
        });
        return;
      }
    }

    // Filter by target repos when cross-repo targeting is specified.
    // If the event has targetRepos, only deliver to registrations whose repo matches.
    if (event.targetRepos && event.targetRepos.length > 0) {
      const targetSet = new Set(event.targetRepos);
      registrations = registrations.filter((r) => targetSet.has(r.repoIdentifier));

      if (registrations.length === 0) {
        logger.debug('No registrations match target repos', {
          eventId: event.id,
          eventName: event.eventName,
          targetRepos: event.targetRepos,
        });
        return;
      }
    }

    // Group registrations by customer for trust boundary checks
    for (const reg of registrations) {
      // Cross-customer trust check: if event is from a different customer, verify trust.
      // When using registrations, the trust boundary is customer-scoped (not routing-key-scoped).
      // For now, we use a simple source routing key comparison; same source routing key = same customer trust.
      if (event.sourceRoutingKey) {
        // Derive a representative routing key for the registration's customer.
        // Cross-customer trust is checked when source routing key differs from any routing key
        // associated with the registered workflow's customer. For simplicity, compare repos.
        if (event.sourceRepo && event.sourceRepo !== reg.repoIdentifier) {
          const trusted = await this.trustStore.isTrusted(
            event.sourceRepo,
            event.sourceRoutingKey,
            reg.repoIdentifier,
            '', // registration is customer-scoped, not routing-key-scoped
            event.eventName,
          );

          if (!trusted) {
            logger.debug('Cross-repo event delivery blocked by trust store (via index)', {
              eventId: event.id,
              sourceRepo: event.sourceRepo,
              targetRepo: reg.repoIdentifier,
            });
            continue;
          }
        }
      }

      // Build a LockFile-like structure from the registration's lock entry
      const syntheticLockFile: LockFile = {
        schemaVersion: SCHEMA_VERSION,
        source: reg.lockEntry.source ?? { file: 'registered', export: '#default' },
        contentHash: reg.lockEntry.contentHash ?? '',
        workflows: [reg.lockEntry],
      };

      // Match against the registered workflow
      const decisions = matchAllWorkflows(syntheticLockFile.workflows, simulatedEvent);
      const matchedDecisions = decisions.filter((d) => d.matched);

      if (matchedDecisions.length > 0) {
        logger.info('Event matched registered workflow', {
          eventId: event.id,
          eventName: event.eventName,
          routingKey: reg.routingKey,
          repoIdentifier: reg.repoIdentifier,
          workflowName: reg.workflowName,
          matchedCount: matchedDecisions.length,
        });

        await this.onEventMatched(event, syntheticLockFile, matchedDecisions, {
          routingKey: reg.routingKey,
          repoIdentifier: reg.repoIdentifier,
          providerContext: reg.providerContext,
        });
      }
    }
  }

  /**
   * Map a stored event to a trigger type string for RegistrationIndex lookup.
   *
   * System events (__workflow_complete, __job_complete) map to their type without __ prefix.
   * Custom events map to 'kici_event'.
   */
  private eventToTriggerType(event: StoredEvent): string {
    if (event.eventName === '__schedule_fire') {
      return 'schedule';
    }
    if (event.eventName.startsWith('__')) {
      return event.eventName.slice(2);
    }
    return 'kici_event';
  }

  /**
   * Build a SimulatedEvent from a StoredEvent for trigger matching.
   *
   * System events (__workflow_complete, __job_complete) map their type by
   * stripping the __ prefix and pass the payload through directly (the
   * matcher checks payload.workflowName, payload.status, etc.).
   *
   * Custom events use type 'kici_event'. The matcher reads eventName and
   * the user payload from event.payload.eventName / event.payload.payload,
   * so we wrap the stored event's metadata into the expected structure.
   */
  private buildSimulatedEvent(event: StoredEvent): SimulatedEvent {
    // System events use the event name without __ prefix as the type,
    // except __schedule_fire which maps to 'schedule' (not 'schedule_fire')
    const isSystemEvent = event.eventName.startsWith('__');
    const type =
      event.eventName === '__schedule_fire'
        ? 'schedule'
        : isSystemEvent
          ? event.eventName.slice(2)
          : 'kici_event';

    // For system events, the payload contains fields like workflowName,
    // status, etc. that the matcher reads directly.
    // For custom events (kici_event), the matcher reads:
    //   - event.payload.eventName (the user-defined event name)
    //   - event.payload.payload (the user-emitted data for JSONPath matching)
    //   - event.payload.sourceRepo (for cross-repo source filter)
    const payload = isSystemEvent
      ? event.payload
      : {
          eventName: event.eventName,
          payload: event.payload,
          sourceRepo: event.sourceRepo,
          sourceRoutingKey: event.sourceRoutingKey,
        };

    return {
      type,
      payload,
      targetBranch: 'main', // N/A for internal events
    };
  }

  /**
   * Catch-up: process unprocessed events missed during downtime.
   *
   * Uses lease-based dispatch identical to the live path, so a catch-up
   * dispatch failure schedules a retry via the leader-only scanner instead
   * of being silently dropped.
   */
  private async catchUp(): Promise<void> {
    const events = await this.eventStore.getUnprocessedSince(this.lastProcessedEventId);

    if (events.length === 0) {
      logger.info('Event catch-up complete, no missed events');
      return;
    }

    logger.info('Catching up on missed events', { count: events.length });

    let processedCount = 0;
    for (const event of events) {
      const leased = await this.eventStore.tryLeaseForProcessing(event.id, this.nodeId);
      if (!leased) {
        logger.debug('Catch-up event already leased or terminal', { eventId: event.id });
        this.lastProcessedEventId = event.id;
        continue;
      }

      await this.dispatchAndRecord(leased);
      this.lastProcessedEventId = event.id;
      processedCount++;
    }

    logger.info('Event catch-up complete', { processedCount, totalChecked: events.length });
  }
}

/**
 * Compute the next retry timestamp using exponential backoff with full
 * jitter. `attempts` is the count AFTER the most recent failed attempt.
 *
 *   target = min(maxBackoffMs, baseBackoffMs * 2^(attempts - 1))
 *   actual = random in [0, target]
 *
 * Full jitter (vs. equal jitter or no jitter) gives the best balance
 * between worst-case retry concentration and average latency, per the AWS
 * "Exponential backoff and jitter" article. baseBackoffMs and
 * maxBackoffMs come from EventRouterConfig so tests can shrink them.
 */
export function computeNextRetryAt(
  attempts: number,
  baseBackoffMs: number,
  maxBackoffMs: number,
  now: () => number = Date.now,
): Date {
  const exponent = Math.max(0, attempts - 1);
  const target = Math.min(maxBackoffMs, baseBackoffMs * Math.pow(2, exponent));
  const delayMs = Math.floor(Math.random() * target);
  return new Date(now() + delayMs);
}
