/**
 * In-memory rate limiter shared by AccessLogWriter and AuditLogger to enforce
 * the per-action / per-actor caps defined in the engine's
 * `POLICY_BY_ACTION` table (one row per minute per actor for diagnostics-class
 * reads).
 *
 * Implementation: a single Map keyed by `${action}:${actorKey}` whose value
 * is the last permit timestamp. The token bucket is implicit — a permit is
 * granted iff `now - last >= floor(60_000 / perMinutePerActor)`. On each
 * permit() call we lazily prune entries older than 5 minutes so memory
 * stays bounded for long-lived orchestrators.
 *
 * Thread-safety: Node's single-threaded event loop guarantees the
 * read-then-write below is atomic per call. No locking needed.
 */
import type { AccessLogAction, AccessLogRateLimiter } from '@kici-dev/engine';

/** TTL after which idle bucket entries are removed during pruning. */
const PRUNE_TTL_MS = 5 * 60_000;

/**
 * Implementation of `AccessLogRateLimiter` (engine interface). Constructed
 * once per orchestrator process and injected into both
 * `AccessLogWriter` and `AuditLogger`.
 */
export class SamplingRateLimiter implements AccessLogRateLimiter {
  private readonly buckets = new Map<string, number>();
  private readonly now: () => number;
  private lastPruneAt: number;

  /**
   * @param now  Time source override (test seam). Defaults to `Date.now`.
   */
  constructor(now: () => number = Date.now) {
    this.now = now;
    this.lastPruneAt = now();
  }

  permit(action: AccessLogAction, actorKey: string, perMinute: number): boolean {
    if (perMinute <= 0) return false;
    const key = `${action}:${actorKey}`;
    const now = this.now();
    const intervalMs = Math.floor(60_000 / perMinute);
    const last = this.buckets.get(key);
    if (last !== undefined && now - last < intervalMs) {
      this.maybePrune(now);
      return false;
    }
    this.buckets.set(key, now);
    this.maybePrune(now);
    return true;
  }

  /**
   * Drop entries older than PRUNE_TTL_MS. Called opportunistically from
   * `permit()` so memory stays bounded without a background timer. With the
   * 1-row/min/actor cap the map is naturally tiny (it grows by one entry
   * per active actor and prunes after five minutes of silence).
   */
  private maybePrune(now: number): void {
    if (now - this.lastPruneAt < PRUNE_TTL_MS) return;
    this.lastPruneAt = now;
    for (const [key, ts] of this.buckets) {
      if (now - ts >= PRUNE_TTL_MS) this.buckets.delete(key);
    }
  }

  /** Test-only: introspect the bucket size. */
  size(): number {
    return this.buckets.size;
  }
}
