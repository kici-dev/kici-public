/**
 * Generic pending-job tracker for coordinating two-phase orchestrator pipelines
 * (build-then-execute, init-then-execute, dynamic-eval-then-execute).
 *
 * The orchestrator dispatches a precursor job (build / init / dynamic eval) and
 * needs to wait for the agent to report completion before continuing. This
 * tracker exposes a deferred Promise per jobId that resolves with a typed
 * payload (or rejects on failure / disconnect).
 *
 * Usage:
 * - dispatcher calls track(jobId), awaits the returned promise
 * - terminal-status handler calls resolve(jobId, value) or reject(jobId, err)
 * - cleanup(jobId) is invoked on agent disconnect to reject with a fixed error
 */

import { createLogger } from '@kici-dev/shared';

interface PendingEntry<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

export interface PendingTrackerOptions<T> {
  /** Logger prefix, e.g. 'pending-builds'. */
  logPrefix: string;
  /** Noun used in log messages, e.g. 'build', 'init', 'dynamic eval'. */
  itemLabel: string;
  /** Error message used when cleanup() rejects a pending entry on disconnect. */
  disconnectError: string;
  /**
   * Optional extractor that derives extra structured log fields from the
   * resolved value (e.g. `jobCount` for dynamic-eval results). The returned
   * keys are merged into the `resolve` log line for telemetry / debugging.
   */
  extractResolveMeta?: (value: T) => Record<string, unknown>;
}

export class PendingTracker<T> {
  private readonly pending = new Map<string, PendingEntry<T>>();
  private readonly logger: ReturnType<typeof createLogger>;
  private readonly opts: PendingTrackerOptions<T>;

  constructor(opts: PendingTrackerOptions<T>) {
    this.opts = opts;
    this.logger = createLogger({ prefix: opts.logPrefix });
  }

  /**
   * Register a pending job and return a promise that resolves when the agent
   * reports completion (or rejects on failure / disconnect).
   *
   * Each call creates a new Promise. If track() is called for the same jobId
   * twice, the previous Promise's callbacks are replaced -- the previous
   * caller's Promise will never settle (orphaned). Callers (e.g. BuildCoordinator)
   * are responsible for coalescing duplicate work upstream.
   */
  track(jobId: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(jobId, { resolve, reject });
      this.logger.debug(`Tracking pending ${this.opts.itemLabel}`, {
        jobId,
        total: this.pending.size,
      });
    });
  }

  /**
   * Resolve a pending entry (agent reported success).
   */
  resolve(jobId: string, value: T): void {
    const entry = this.pending.get(jobId);
    if (entry) {
      this.pending.delete(jobId);
      entry.resolve(value);
      const extra = this.opts.extractResolveMeta?.(value) ?? {};
      this.logger.info(`Pending ${this.opts.itemLabel} resolved`, {
        jobId,
        ...extra,
        remaining: this.pending.size,
      });
    }
  }

  /**
   * Reject a pending entry (agent reported failure).
   */
  reject(jobId: string, error: Error): void {
    const entry = this.pending.get(jobId);
    if (entry) {
      this.pending.delete(jobId);
      entry.reject(error);
      this.logger.info(`Pending ${this.opts.itemLabel} rejected`, {
        jobId,
        error: error.message,
      });
    }
  }

  /**
   * Clean up on agent disconnect. Rejects with the configured disconnect error.
   */
  cleanup(jobId: string): void {
    const entry = this.pending.get(jobId);
    if (entry) {
      this.pending.delete(jobId);
      entry.reject(new Error(this.opts.disconnectError));
      this.logger.warn(`Pending ${this.opts.itemLabel} cleaned up (agent disconnect)`, { jobId });
    }
  }

  /**
   * Check if an entry is pending for a given jobId.
   */
  has(jobId: string): boolean {
    return this.pending.has(jobId);
  }

  /**
   * Number of pending entries (for metrics / debugging).
   */
  get size(): number {
    return this.pending.size;
  }
}
