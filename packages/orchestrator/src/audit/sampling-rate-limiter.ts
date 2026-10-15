/**
 * In-memory rate limiter shared by AccessLogWriter and AuditLogger, enforcing
 * the engine's `POLICY_BY_ACTION` per-action / per-actor caps (one row per
 * minute per actor for diagnostics-class reads).
 *
 * One Map of `${action}:${actorKey}` → last permit timestamp; a permit is
 * granted iff `now - last >= floor(60_000 / perMinutePerActor)`. permit()
 * lazily prunes entries older than 5 minutes so memory stays bounded.
 *
 * The single-threaded event loop makes each read-then-write atomic; no locking.
 */
import type { AccessLogAction, AccessLogRateLimiter } from '@kici-dev/engine';

/** TTL after which idle bucket entries are removed during pruning. */
const PRUNE_TTL_MS = 5 * 60_000;

/** One per orchestrator process, injected into `AccessLogWriter` and `AuditLogger`. */
export class SamplingRateLimiter implements AccessLogRateLimiter {
  private readonly buckets = new Map<string, number>();
  private readonly now: () => number;
  private lastPruneAt: number;

  /** @param now  Time source (test seam). */
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
   * Called from `permit()`, so no background timer is needed. The map holds
   * one entry per active actor, pruned after five minutes of silence.
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
