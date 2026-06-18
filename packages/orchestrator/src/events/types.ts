/**
 * Event routing configuration and types.
 */

/**
 * Configuration for the event routing system.
 */
export interface EventRouterConfig {
  /** Maximum allowed chain depth before circuit breaker trips (default: 10) */
  maxChainDepth: number;
  /** Maximum event emissions per workflow per minute (default: 100) */
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
   * Only honoured when `KICI_TEST_MODE=1` is set at config-load time —
   * production deployments never see this knob even if the env var is
   * planted by accident. Source the value from
   * `KICI_TEST_EVENT_FAIL_FIRST_N` (a JSON object literal).
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
 * Parse the `KICI_TEST_EVENT_FAIL_FIRST_N` JSON payload, gated by
 * `KICI_TEST_MODE`. Returns the parsed map or `undefined` when:
 *
 * - `testMode` is false (the master switch). The JSON value is ignored
 *   entirely; production deployments never see fault-injection even if
 *   the per-event env var is accidentally planted.
 * - the JSON value is absent / empty.
 * - the JSON value is malformed or carries a wrong-shape entry. We
 *   refuse to fall back to a partial map: a typo on one line silently
 *   skipping that test would be confusing in CI logs.
 *
 * The accepted shape is `{ "<eventName>": <number> }`; non-string keys
 * and non-number values are rejected. The numeric value is the inclusive
 * upper bound of attempts to fail (so `1` fails the first attempt and
 * succeeds on retry; `99` exceeds `maxDispatchAttempts` and lands the
 * row in the DLQ).
 */
export function parseFaultInjectionMap(
  testMode: boolean,
  raw: string | undefined,
): Record<string, number> | undefined {
  if (!testMode) return undefined;
  if (!raw || raw.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return undefined;
    }
    out[key] = value;
  }
  if (Object.keys(out).length === 0) return undefined;
  return out;
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
