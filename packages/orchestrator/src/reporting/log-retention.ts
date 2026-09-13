import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { LogStorage } from './log-storage.js';

const logger = createLogger({ prefix: 'log-retention' });

/** Prefix under which step-log objects live (see the LogStorage layout). */
const LOG_ROOT_PREFIX = 'executions/';

/**
 * Delete step-log objects older than `ttlDays` in one bulk pass.
 *
 * Step-log objects are write-once (appended during the run, untouched after
 * finalize), so last-modified time is the correct expiry basis — a recent or
 * still-running run's objects were all written within the window and survive.
 * `ttlDays <= 0` disables the sweep (returns 0). Expired objects are collected
 * then bulk-deleted via `deleteMany` (S3 DeleteObjects), so a large sweep is a
 * handful of API calls, not one-per-object. A delete failure is logged and the
 * cleanup tick is not aborted.
 *
 * @returns Number of objects deleted.
 */
export async function pruneExpiredLogs(
  storage: LogStorage,
  ttlDays: number,
  now: Date = new Date(),
): Promise<number> {
  if (ttlDays <= 0) return 0;
  const cutoff = now.getTime() - ttlDays * 86_400_000;
  const objects = await storage.listWithMetadata(LOG_ROOT_PREFIX);
  const expired = objects.filter((o) => o.lastModified.getTime() < cutoff).map((o) => o.path);
  if (expired.length === 0) return 0;
  try {
    return await storage.deleteMany(expired);
  } catch (err) {
    logger.error('Failed to bulk-delete expired log objects', {
      count: expired.length,
      error: toErrorMessage(err),
    });
    return 0;
  }
}
