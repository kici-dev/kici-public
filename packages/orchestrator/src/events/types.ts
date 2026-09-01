/**
 * Event routing configuration and types.
 */

/**
 * Configuration for the event routing system.
 */
export interface EventRouterConfig {
  /** Maximum allowed chain depth before circuit breaker trips (default: 10) */
  maxChainDepth: number;
  /**
   * Max user-event emissions per (source routing key + event name) per minute
   * (sliding 60s window). System events (`__`-prefixed, e.g. __workflow_complete)
   * are EXEMPT -- they are orchestrator-emitted once per completion and cannot
   * loop, so the storm guard does not apply. Default 100.
   */
  rateLimitPerWorkflowPerMinute: number;
  /** TTL for persisted events in seconds (default: 604800 = 7 days) */
  eventTtlSeconds: number;
  /** Interval between cleanup runs in milliseconds (default: 3600000 = 1 hour) */
  cleanupIntervalMs: number;
  /** Max dispatch attempts before an event is moved to the DLQ (default: 5) */
  maxDispatchAttempts: number;
  /** How long a dispatch lease is valid before another node may steal it (default: 60_000) */
  leaseDurationMs: number;
  /** Base backoff for exponential retry, with full jitter (default: 5_000) */
  retryBaseBackoffMs: number;
  /** Maximum backoff cap (default: 300_000 = 5 min) */
  retryMaxBackoffMs: number;
  /** Interval at which the leader-only retry scanner ticks (default: 10_000) */
  retryScanIntervalMs: number;
  /**
   * **Test-only.** Per-event-name fault injection: when `attempts <= N`,
   * the EventRouter throws a synthetic dispatch error to drive the retry /
   * DLQ path. Used by the fault-injection E2E to prove the lease + retry
   * loop dispatches a real run when the inner dispatch eventually
   * succeeds, and lands the row in the DLQ when N exceeds
   * `maxDispatchAttempts`.
   *
   * Undefined in the shipped orchestrator: only the build-time test double
   * supplies this map, via the injected fault-injection policy.
   */
  debugFailFirstNAttemptsByEvent?: Record<string, number>;
}

/**
 * Reason an event landed in the DLQ.
 */
export type DlqReason = 'exhausted_retries' | 'non_retryable';

/**
 * A stored internal event (matches DB row shape but with JS types).
 */
export interface StoredEvent {
  id: string;
  eventName: string;
  payload: Record<string, unknown>;
  sourceRepo?: string;
  sourceRoutingKey?: string;
  sourceRunId?: string;
  sourceJobId?: string;
  /** Optional target repos for cross-repo event targeting */
  targetRepos?: string[];
  chainDepth: number;
  processed: boolean;
  createdAt: Date;
  expiresAt: Date;
  /** Lease + retry + DLQ fields (added by migration 014) */
  claimedAt: Date | null;
  claimedBy: string | null;
  attempts: number;
  lastError: string | null;
  nextRetryAt: Date | null;
  dlqAt: Date | null;
  dlqReason: DlqReason | null;
}

/**
 * Default event router configuration.
 */
export const DEFAULT_EVENT_ROUTER_CONFIG: EventRouterConfig = {
  maxChainDepth: 10,
  rateLimitPerWorkflowPerMinute: 100,
  eventTtlSeconds: 604800, // 7 days
  cleanupIntervalMs: 3600000, // 1 hour
  maxDispatchAttempts: 5,
  leaseDurationMs: 60_000,
  retryBaseBackoffMs: 5_000,
  retryMaxBackoffMs: 300_000,
  retryScanIntervalMs: 10_000,
};
