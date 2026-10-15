/**
 * Pending-job tracker for two-phase pipelines (build / init / dynamic eval,
 * then execute): a deferred Promise per precursor jobId that resolves with a
 * typed payload, or rejects on failure / disconnect.
 *
 * The dispatcher awaits track(jobId); the terminal-status handler calls
 * resolve or reject; cleanup(jobId) rejects with a fixed error on disconnect.
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
  /** Extra fields for the `resolve` log line (e.g. dynamic-eval `jobCount`). */
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
   * A second track() for the same jobId replaces the callbacks, orphaning the
   * first caller's Promise forever. Callers (e.g. BuildCoordinator) coalesce
   * duplicate work upstream.
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

  /** Agent reported success. */
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

  /** Agent reported failure. */
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

  /** On agent disconnect: rejects with the configured disconnect error. */
  cleanup(jobId: string): void {
    const entry = this.pending.get(jobId);
    if (entry) {
      this.pending.delete(jobId);
      entry.reject(new Error(this.opts.disconnectError));
      this.logger.warn(`Pending ${this.opts.itemLabel} cleaned up (agent disconnect)`, { jobId });
    }
  }

  has(jobId: string): boolean {
    return this.pending.has(jobId);
  }

  /** For metrics / debugging. */
  get size(): number {
    return this.pending.size;
  }

  /**
   * The awaited job ids, for the shared-database channel. A sibling
   * coordinator's agent may claim the job from the shared queue; its terminal
   * frame never reaches this process but lands in `execution_jobs`, which
   * `PendingPrecursorDbWatcher` polls for exactly this set.
   */
  trackedJobIds(): string[] {
    return [...this.pending.keys()];
  }
}
