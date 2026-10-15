/**
 * In-process bounded record of recent scaler spawn failures.
 *
 * The scaler manager records every `scaler.failed` event here where it
 * increments the fleet-wide Prometheus counter; the diagnose scaler check reads
 * it grouped per backend instance. Memory-only: the window resets on restart,
 * which is acceptable for an on-demand operator view over a short window.
 */

export interface ScalerFailureRecord {
  /** Configured scaler `name`; the diagnose row key. */
  backendName: string;
  /** 'container' | 'bare-metal' | 'firecracker' | 'event' | 'unknown'. */
  backendType: string;
  /** True when the failed spawn was bound to a queued job (a run was affected). */
  bound: boolean;
  detail: string;
  timestampMs: number;
}

export interface BackendFailureSummary {
  backendType: string;
  boundCount: number;
  unboundCount: number;
  /** Detail of the most recent failure in the window. */
  lastError: string;
  lastAtMs: number;
}

/** Bounds memory under a failure flood. */
const DEFAULT_MAX_ENTRIES = 256;

export class ScalerFailureTracker {
  private readonly records: ScalerFailureRecord[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  /** Record a failure, evicting the oldest entry when over capacity. */
  record(rec: ScalerFailureRecord): void {
    this.records.push(rec);
    if (this.records.length > this.maxEntries) {
      this.records.shift();
    }
  }

  /**
   * Group failures newer than `nowMs - windowMs` by backend instance name.
   * `nowMs` is injected so callers control the clock (and tests are deterministic).
   */
  recentByBackend(windowMs: number, nowMs: number): Map<string, BackendFailureSummary> {
    const cutoff = nowMs - windowMs;
    const out = new Map<string, BackendFailureSummary>();

    for (const rec of this.records) {
      if (rec.timestampMs < cutoff) continue;
      const existing = out.get(rec.backendName);
      if (!existing) {
        out.set(rec.backendName, {
          backendType: rec.backendType,
          boundCount: rec.bound ? 1 : 0,
          unboundCount: rec.bound ? 0 : 1,
          lastError: rec.detail,
          lastAtMs: rec.timestampMs,
        });
        continue;
      }
      if (rec.bound) existing.boundCount += 1;
      else existing.unboundCount += 1;
      if (rec.timestampMs >= existing.lastAtMs) {
        existing.lastError = rec.detail;
        existing.lastAtMs = rec.timestampMs;
        existing.backendType = rec.backendType;
      }
    }

    return out;
  }
}
