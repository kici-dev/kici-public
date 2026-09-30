/**
 * Holding a build job's success until the cache publish its agent reported
 * just before it has finished.
 *
 * A build agent sends `cache.upload.complete` and then, moments later, the
 * build's terminal `job.status success`. The agent WebSocket handler runs
 * frames concurrently, so without this record the success can release the
 * jobs that wait on the build while the pointer naming the uploaded tarball is
 * still being written — and they dispatch without the cache URL.
 *
 * The upload frame registers here before its first `await`. Frames enter the
 * handler in wire order, so the registration is in place by the time the
 * success frame is handled. The success then waits, bounded by the org's
 * `cache_upload_settle_timeout_ms` (cluster default
 * `KICI_CACHE_UPLOAD_SETTLE_TIMEOUT_MS`).
 */

import type { Kysely } from 'kysely';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { Database } from '../db/types.js';

const logger = createLogger({ prefix: 'cache-upload-settle' });

/** How a build success's wait for its cache publish ended. */
export enum CacheUploadSettleOutcome {
  /** No publish was in flight for the job. */
  None = 'none',
  /** The effective timeout is 0: the wait is turned off. */
  Disabled = 'disabled',
  /** Every in-flight publish finished, successfully or not. */
  Settled = 'settled',
  /** The bound passed first. The publish may still finish afterwards. */
  TimedOut = 'timed-out',
}

/**
 * The cache publishes in flight, per job. A full build registers two (the
 * dependency tarball and the source tarball); a publish always settles —
 * success or failure — so a waiter never sees a rejection.
 */
export class InFlightCacheUploads {
  private readonly inFlight = new Map<string, Set<Promise<void>>>();

  /** Register one publish for `jobId`; the returned function settles it (idempotent). */
  begin(jobId: string): () => void {
    let resolve!: () => void;
    const publish = new Promise<void>((r) => {
      resolve = r;
    });
    const publishes = this.inFlight.get(jobId) ?? new Set<Promise<void>>();
    publishes.add(publish);
    this.inFlight.set(jobId, publishes);
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      resolve();
      const current = this.inFlight.get(jobId);
      if (!current) return;
      current.delete(publish);
      if (current.size === 0) this.inFlight.delete(jobId);
    };
  }

  has(jobId: string): boolean {
    return this.inFlight.has(jobId);
  }

  /** Number of jobs with a publish in flight. */
  get size(): number {
    return this.inFlight.size;
  }

  /**
   * Wait for every publish registered for `jobId` at call time, bounded by
   * `timeoutMs`. A timeout leaves the records in place: they clear when their
   * publishes settle.
   */
  async waitFor(jobId: string, timeoutMs: number): Promise<CacheUploadSettleOutcome> {
    const publishes = this.inFlight.get(jobId);
    if (!publishes || publishes.size === 0) return CacheUploadSettleOutcome.None;
    if (timeoutMs <= 0) return CacheUploadSettleOutcome.Disabled;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<CacheUploadSettleOutcome>((resolve) => {
      timer = setTimeout(() => resolve(CacheUploadSettleOutcome.TimedOut), timeoutMs);
      timer.unref?.();
    });
    const settled = Promise.all([...publishes]).then(() => CacheUploadSettleOutcome.Settled);
    try {
      return await Promise.race([settled, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** What the agent WebSocket handler needs to hold a build's success. */
export interface CacheUploadSettle {
  uploads: InFlightCacheUploads;
  /** The effective bound for the job's org (org override, else cluster default). */
  timeoutMsFor: (orgId: string | undefined) => Promise<number>;
}

export interface CacheUploadSettleResult {
  outcome: CacheUploadSettleOutcome;
  timeoutMs?: number;
  waitedMs?: number;
}

/**
 * Wait for a job's in-flight cache publishes. Reads the setting only when a
 * publish is in flight, so an ordinary job's success costs no query.
 */
export async function awaitCacheUploadSettle(
  settle: CacheUploadSettle | undefined,
  job: { jobId: string; orgId: string | undefined },
): Promise<CacheUploadSettleResult> {
  if (!settle?.uploads.has(job.jobId)) return { outcome: CacheUploadSettleOutcome.None };
  const timeoutMs = await settle.timeoutMsFor(job.orgId);
  const started = Date.now();
  const outcome = await settle.uploads.waitFor(job.jobId, timeoutMs);
  return { outcome, timeoutMs, waitedMs: Date.now() - started };
}

/**
 * Resolve the settle bound for an org: `org_settings.cache_upload_settle_timeout_ms`
 * when set (0 included), otherwise `fallbackMs`. A missing DB, org, row or
 * value, or a failed query, falls back — the caller is a frame handler that
 * must not reject.
 */
export function createCacheUploadSettleTimeoutReader(
  db: Kysely<Database> | undefined,
  fallbackMs: number,
): (orgId: string | undefined) => Promise<number> {
  return async (orgId) => {
    if (!db || !orgId) return fallbackMs;
    try {
      const row = await db
        .selectFrom('org_settings')
        .select('cache_upload_settle_timeout_ms')
        .where('customer_id', '=', orgId)
        .executeTakeFirst();
      const value = row?.cache_upload_settle_timeout_ms;
      if (value != null) return Number(value);
    } catch (err) {
      logger.warn(
        'Failed to read org_settings.cache_upload_settle_timeout_ms, using cluster default',
        { orgId, error: toErrorMessage(err) },
      );
    }
    return fallbackMs;
  };
}
