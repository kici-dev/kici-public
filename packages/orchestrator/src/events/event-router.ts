import type pg from 'pg';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/types.js';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { LockFile, SimulatedEvent, WorkflowDecision } from '@kici-dev/engine';
import { matchAllWorkflows, SCHEMA_VERSION, reservedEventNamePrefix } from '@kici-dev/engine';
import { EVENT_CATCHUP_BATCH_SIZE } from './event-store.js';
import type { EventStore } from './event-store.js';
import type { EventCircuitBreaker } from './circuit-breaker.js';
import type { TrustStore } from './trust-store.js';
import type { RegisteredWorkflow, RegistrationIndex } from '../registration/registration-index.js';
import type { EventRouterConfig, StoredEvent } from './types.js';
import type { ClusterSettingsReader } from '../cluster/cluster-settings-reader.js';
import { appendBatchItem, openOrGetBatchWindow } from './batch-accumulator.js';
import {
  eventAttemptsHistogram,
  eventCatchUpFailuresTotal,
  eventDispatchSuccessTotal,
  eventDlqTotal,
  eventRetryTotal,
} from '../metrics/prometheus.js';

const logger = createLogger({ prefix: 'event-router' });

/**
 * System events are exempt from the per-source event-storm rate limiter: they
 * are orchestrator-emitted (never a user `ctx.emit`) with a bounded chain depth,
 * so they cannot loop. Two families qualify — the `__`-prefixed workflow/
 * job-complete events, and the reserved `kici.`-prefixed events (today: the
 * event scaler's scale-up / scale-down), which fire on real scaling demand and
 * must not be dropped by a 100/min bucket.
 *
 * "Never a user `ctx.emit`" is what the exemption rests on, and it is ENFORCED
 * rather than assumed: both prefixes are refused at the emit path (the SDK
 * client-side, the orchestrator's `event.emit` handler authoritatively), which
 * is the same reservation this predicate reads.
 */
export function isRateExemptEventName(eventName: string): boolean {
  return reservedEventNamePrefix(eventName) !== undefined;
}

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
  /**
   * The registration's default branch (`null` when it was never captured).
   * A `__schedule_fire` run executes this branch's lock file, so the dispatch
   * adapter presents it as that run's branch when a context evaluates branch
   * restrictions.
   */
  defaultBranch: string | null;
}

export interface EventRouterOptions {
  db: Kysely<Database>;
  pool: pg.Pool;
  eventStore: EventStore;
  circuitBreaker: EventCircuitBreaker;
  trustStore: TrustStore;
  config: EventRouterConfig;
  /**
   * Fleet-wide settings reader. When present, the per-event insert TTL and the
   * max-dispatch-attempts cap are read live from cluster_settings, falling back
   * to `config.eventTtlSeconds` / `config.maxDispatchAttempts`.
   */
  clusterSettings?: ClusterSettingsReader;
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
  /**
   * Boot latch: resolves once this process can actually dispatch a matched
   * event.
   *
   * `start()` runs its catch-up scan well before the dispatch dependencies are
   * assembled (the `ProcessingDeps` bag is built at `createApp`), and a restart
   * with a backlog is exactly when that window is loaded. Without the latch a
   * backlogged event can spend all `maxDispatchAttempts` (default 5) inside the
   * window — full-jitter backoff can re-fire almost immediately — and land in
   * the DLQ, which is terminal loss.
   *
   * Consumed two DIFFERENT ways, because the two paths sit on opposite sides of
   * the caller that resolves it:
   *
   * - **Live notification** — awaited inline, before leasing. The handler runs
   *   off the pg client's event loop, so nothing upstream is blocked.
   * - **Catch-up** — the scan is SCHEDULED behind the latch, never awaited by
   *   `start()`. The composition root resolves the latch only after `start()`
   *   returns, so awaiting inline would be a guaranteed startup deadlock.
   *
   * Absent ⇒ no gating, and the catch-up runs inline exactly as before (tests,
   * and any caller that is ready before `start()`).
   */
  dispatchReady?: () => Promise<void>;
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
  private readonly clusterSettings?: ClusterSettingsReader;
  private readonly onEventMatched: EventRouterOptions['onEventMatched'];
  private readonly dispatchReady: EventRouterOptions['dispatchReady'];
  /** The deferred catch-up scan, when `start()` scheduled one behind the latch. */
  private catchUpScan: Promise<void> | null = null;
  /**
   * The catch-up scan ITSELF, set the moment it actually begins.
   *
   * Distinct from `catchUpScan`, which is the whole latch-then-scan chain.
   * `stop()` awaits this one, never the chain: the latch is resolved by the
   * composition root PAST `start()`, so a bootstrap that fails in between
   * leaves it pending forever and awaiting the chain would hang shutdown.
   * Awaiting only a scan that has begun bounds the wait by the scan.
   */
  private runningCatchUp: Promise<void> | null = null;
  /** Set by `stop()` so a latch that resolves after shutdown starts no scan. */
  private stopped = false;
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
    this.clusterSettings = options.clusterSettings;
    this.onEventMatched = options.onEventMatched;
    this.dispatchReady = options.dispatchReady;
    this.registrationIndex = options.registrationIndex;
    this.nodeId = options.nodeId;
  }

  /**
   * Start listening for events via PostgreSQL LISTEN/NOTIFY.
   * Runs catch-up on start to process events missed during downtime.
   */
  async start(): Promise<void> {
    // Clear the shutdown flag. A stop→start cycle otherwise leaves it latched
    // on, and every subsequent start silently skips its catch-up scan — the one
    // thing the scan exists to do is recover the backlog a stop left behind.
    this.stopped = false;

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

    // Catch-up: process events missed during downtime.
    //
    // With no boot latch this stays inline, exactly as before. With one it is
    // SCHEDULED, never awaited: the only thing that resolves the latch is the
    // composition root continuing PAST this call, so awaiting the scan here
    // would wait on a resolve that is downstream of the wait — a startup
    // deadlock on every boot, not merely a slow one. LISTEN is already
    // registered above, so no live notification is missed while the scan waits.
    if (!this.dispatchReady) {
      await this.catchUp();
      return;
    }
    this.catchUpScan = this.dispatchReady()
      .then(() => {
        // A shutdown between `start()` and the latch must not start a scan.
        // Nothing awaits between this check and the assignment below, so
        // `stop()` either sees the scan it must wait for or prevents it.
        if (this.stopped) return;
        this.runningCatchUp = this.catchUp();
        return this.runningCatchUp;
      })
      .catch((err) => {
        // This no longer fails the bootstrap, so the failure has to be visible
        // on its own. The counter is what an alert can fire on; the log line
        // carries the reason.
        eventCatchUpFailuresTotal.add(1);
        logger.error('Deferred catch-up scan failed', { error: toErrorMessage(err) });
      })
      .finally(() => {
        this.runningCatchUp = null;
      });
  }

  /**
   * The deferred catch-up scan scheduled by `start()` behind the boot latch, or
   * `null` when the scan ran inline (no latch configured).
   *
   * Exposed so a caller can await the scan rather than poll for its effects.
   * `start()` deliberately does not await it — see the comment there.
   */
  get catchUpSettled(): Promise<void> | null {
    return this.catchUpScan;
  }

  /**
   * Stop listening and release the dedicated pg client.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    // Let a scan that is already running finish, so shutdown does not overlap
    // it — the scan leases events and dispatches them, and tearing the client
    // out from under it leaves those leases held by a process that is gone.
    // The chain's own `.catch()` means this never rejects.
    await this.runningCatchUp;
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

    // Check circuit breaker -- rate limit.
    // System events (`__`- or `kici.`-prefixed) are orchestrator-emitted and
    // cannot loop, so the event-storm rate limiter (a guard for user ctx.emit)
    // does not apply — see isRateExemptEventName. User events are keyed per
    // (source routing key + event name) so the limit is genuinely
    // per-workflow-source, not one global bucket per event name.
    if (!isRateExemptEventName(event.eventName)) {
      const rateKey = `${event.sourceRoutingKey ?? 'unknown'}:${event.eventName}`;
      const rateCheck = await this.circuitBreaker.checkRateLimit(rateKey);
      if (!rateCheck.allowed) {
        throw new Error(
          `Rate limit exceeded for event '${event.eventName}'. Retry after ${rateCheck.retryAfterMs}ms`,
        );
      }
    }

    // Persist event. TTL is a fleet-wide cluster tunable (live override wins).
    const ttlSeconds =
      (await this.clusterSettings?.getNumber(
        'event_router_event_ttl_seconds',
        this.config.eventTtlSeconds,
      )) ?? this.config.eventTtlSeconds;
    const ttlMs = ttlSeconds * 1000;
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
    // Before leasing, not after: a lease held across the wait would have to be
    // reclaimed by the leader scanner if bootstrap were slow.
    await this.dispatchReady?.();
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
      // is only populated by the build-time test double's injected
      // fault-injection policy; the shipped orchestrator never reaches
      // this branch.
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
      // Max dispatch attempts is a fleet-wide cluster tunable (live override wins).
      const maxDispatchAttempts =
        (await this.clusterSettings?.getNumber(
          'event_router_max_dispatch_attempts',
          this.config.maxDispatchAttempts,
        )) ?? this.config.maxDispatchAttempts;
      if (event.attempts >= maxDispatchAttempts) {
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
          maxDispatchAttempts,
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

    // For __workflows_failed_batch events, the leader sweep already targeted the
    // single subscribing registration (via registrationId in payload). Only match
    // that one so a shared batch event does not dispatch every batch subscriber.
    if (event.eventName === '__workflows_failed_batch' && event.payload.registrationId) {
      const targetId = event.payload.registrationId as string;
      registrations = registrations.filter((r) => r.id === targetId);
      if (registrations.length === 0) {
        logger.debug('Batch event target registration not found', {
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
      if (matchedDecisions.length === 0) continue;

      // A failed workflow_complete that matched a workflowsFailedBatch trigger is
      // buffered into the accumulation window instead of dispatched now; the rest
      // dispatch as usual.
      const dispatchNow = await this.bufferBatchDecisions(event, reg, matchedDecisions);
      if (dispatchNow.length === 0) continue;

      logger.info('Event matched registered workflow', {
        eventId: event.id,
        eventName: event.eventName,
        routingKey: reg.routingKey,
        repoIdentifier: reg.repoIdentifier,
        workflowName: reg.workflowName,
        matchedCount: dispatchNow.length,
      });

      await this.onEventMatched(event, syntheticLockFile, dispatchNow, {
        routingKey: reg.routingKey,
        repoIdentifier: reg.repoIdentifier,
        providerContext: reg.providerContext,
        defaultBranch: reg.defaultBranch,
      });
    }
  }

  /**
   * Partition matched decisions into "dispatch now" and "buffer into a batch
   * window". A decision whose matched trigger is `workflows_failed_batch` and
   * whose event is a failed `__workflow_complete` is buffered (and excluded from
   * the returned dispatch set) so the whole burst notifies once per window.
   *
   * Self-exclusion: a failed `__workflow_complete` whose originating run was
   * itself dispatched by a failure-lifecycle trigger is neither buffered nor
   * dispatched — a broken notifier must not re-trigger the batch on its own
   * failure. The chain-depth breaker remains the backstop for anything missed.
   */
  private async bufferBatchDecisions(
    event: StoredEvent,
    reg: RegisteredWorkflow,
    matchedDecisions: WorkflowDecision[],
  ): Promise<WorkflowDecision[]> {
    const isFailedCompletion =
      event.eventName === '__workflow_complete' && event.payload.status === 'failed';
    if (!isFailedCompletion) return matchedDecisions;

    const dispatchNow: WorkflowDecision[] = [];
    let selfExcluded: boolean | null = null;
    for (const decision of matchedDecisions) {
      const trigger = reg.lockEntry.triggers[decision.matchedTrigger ?? -1];
      if (trigger?._type !== 'workflows_failed_batch') {
        dispatchNow.push(decision);
        continue;
      }
      // Resolve the self-exclusion lookup once per event (all batch decisions
      // for this registration share the same originating run).
      if (selfExcluded === null) {
        selfExcluded = await this.isFailureLifecycleRun(event.sourceRunId);
      }
      if (selfExcluded) {
        logger.debug('Skipping batch buffering for failure-lifecycle run (self-exclusion)', {
          eventId: event.id,
          sourceRunId: event.sourceRunId,
          registrationId: reg.id,
        });
        continue;
      }
      await this.bufferBatchFailure(event, reg, trigger.accumulateFor);
    }
    return dispatchNow;
  }

  /** Open (or reuse) the registration's batch window and append the failed run. */
  private async bufferBatchFailure(
    event: StoredEvent,
    reg: RegisteredWorkflow,
    accumulateForMs: number,
  ): Promise<void> {
    const { windowId, opened } = await openOrGetBatchWindow(this.db, {
      registrationId: reg.id,
      customerId: reg.customerId,
      routingKey: reg.routingKey,
      repoIdentifier: reg.repoIdentifier,
      accumulateForMs,
    });
    await appendBatchItem(this.db, {
      windowId,
      run: {
        runId: (event.payload.runId as string) ?? event.sourceRunId ?? '',
        repoIdentifier: (event.payload.sourceRepo as string) ?? reg.repoIdentifier,
        workflowName: (event.payload.workflowName as string) ?? reg.workflowName,
        failureClass: (event.payload.failureClass as string | undefined) ?? null,
        senderUsername: (event.payload.senderUsername as string | undefined) ?? null,
      },
    });
    logger.debug('Buffered failed run into batch window', {
      eventId: event.id,
      registrationId: reg.id,
      windowId,
      openedWindow: opened,
    });
  }

  /**
   * True when the given run was dispatched by a failure-lifecycle trigger
   * (`workflows_failed_batch` or a `workflow_complete` failed-status trigger),
   * recorded in `execution_runs.trigger_decision.dispatchedByFailureLifecycle`
   * at dispatch time. Used for batch self-exclusion.
   */
  private async isFailureLifecycleRun(runId?: string | null): Promise<boolean> {
    if (!runId) return false;
    const row = await this.db
      .selectFrom('execution_runs')
      .select('trigger_decision')
      .where('run_id', '=', runId)
      .executeTakeFirst();
    if (!row?.trigger_decision) return false;
    try {
      const parsed = JSON.parse(row.trigger_decision) as Record<string, unknown>;
      return parsed.dispatchedByFailureLifecycle === true;
    } catch {
      return false;
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
   * Match a kici event by name against the SOURCE repo's own `kiciEvent({ name })`
   * subscribers, returning the matched decisions plus the synthetic lock file each
   * was matched against.
   *
   * This reuses the exact match path `processSubscriptions` uses for a custom
   * event — the `kici_event` index lookup plus `matchAllWorkflows` against a
   * one-workflow synthetic lock file — but scoped to `sourceRepo` and without the
   * async event-store round-trip, so an invoke gate can summon the repo's opt-in
   * workflows synchronously and correlate each spawned run. The match is scoped to
   * the source repo's own registrations (source == target), so no cross-repo trust
   * check applies.
   */
  matchKiciEventSubscribers(
    eventName: string,
    payload: Record<string, unknown>,
    sourceRepo: string,
    sourceRoutingKey?: string,
  ): Array<{ reg: RegisteredWorkflow; lockFile: LockFile; decisions: WorkflowDecision[] }> {
    const simulatedEvent: SimulatedEvent = {
      type: 'kici_event',
      payload: { eventName, payload, sourceRepo, sourceRoutingKey },
      targetBranch: 'main',
    };
    const registrations = this.registrationIndex
      .getByEventType('kici_event')
      .filter((reg) => reg.repoIdentifier === sourceRepo);
    const out: Array<{
      reg: RegisteredWorkflow;
      lockFile: LockFile;
      decisions: WorkflowDecision[];
    }> = [];
    for (const reg of registrations) {
      const lockFile: LockFile = {
        schemaVersion: SCHEMA_VERSION,
        source: reg.lockEntry.source ?? { file: 'registered', export: '#default' },
        contentHash: reg.lockEntry.contentHash ?? '',
        workflows: [reg.lockEntry],
      };
      const decisions = matchAllWorkflows(lockFile.workflows, simulatedEvent).filter(
        (d) => d.matched,
      );
      if (decisions.length > 0) out.push({ reg, lockFile, decisions });
    }
    return out;
  }

  /**
   * Catch-up: process every unprocessed event missed during downtime.
   *
   * Pages through the backlog with a keyset cursor: fetch a batch, dispatch
   * each event (lease-based, identical failure semantics to the live path),
   * advance the cursor to the last event of the batch, and repeat until a
   * batch returns fewer than EVENT_CATCHUP_BATCH_SIZE rows. Without this loop
   * only the oldest page (100 events) would be dispatched and the remainder
   * would sit unprocessed — invisible to both the live NOTIFY path and the
   * retry scanner — until the TTL cleanup deleted them undelivered.
   *
   * The store's cursor is strictly monotone over (created_at, id), so a
   * still-unprocessed retrying event at or before the cursor is never
   * re-fetched — that strict advance is what guarantees this loop terminates.
   */
  private async catchUp(): Promise<void> {
    let totalChecked = 0;
    let processedCount = 0;

    for (;;) {
      const events = await this.eventStore.getUnprocessedSince(
        this.lastProcessedEventId,
        EVENT_CATCHUP_BATCH_SIZE,
      );

      if (events.length === 0) {
        break;
      }

      totalChecked += events.length;

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

      // A short page means we've drained the backlog. A full page means there
      // may be more — the cursor advanced to this page's last event above.
      if (events.length < EVENT_CATCHUP_BATCH_SIZE) {
        break;
      }
    }

    if (totalChecked === 0) {
      logger.info('Event catch-up complete, no missed events');
      return;
    }

    logger.info('Event catch-up complete', { processedCount, totalChecked });
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
