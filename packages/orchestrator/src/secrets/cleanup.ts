/**
 * Periodic cleanup of orphaned ephemeral keys and secret outputs.
 *
 * Runs on a configurable interval (default: 1 hour) and deletes rows
 * from run_ephemeral_keys and run_secret_outputs older than a configurable
 * threshold (default: 24 hours). This catches data from crashed or
 * abandoned runs whose normal cleanup never fired.
 */
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { toErrorMessage } from '@kici-dev/shared';

export interface SecretCleanupDeps {
  db: Kysely<Database>;
  /** Max age in hours before rows are considered orphaned. Default: 24 */
  maxAgeHours?: number;
  /** Optional logger for cleanup messages */
  logger?: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
  };
}

/**
 * Delete orphaned ephemeral keys and secret outputs older than maxAgeHours.
 *
 * @returns Count of deleted rows from each table
 */
export async function cleanupOrphanedSecrets(
  db: Kysely<Database>,
  maxAgeHours = 24,
): Promise<{ keysDeleted: number; outputsDeleted: number }> {
  const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);

  const keysResult = await db
    .deleteFrom('run_ephemeral_keys')
    .where('created_at', '<', cutoff)
    .execute();

  const outputsResult = await db
    .deleteFrom('run_secret_outputs')
    .where('created_at', '<', cutoff)
    .execute();

  return {
    keysDeleted: Number(keysResult[0]?.numDeletedRows ?? 0n),
    outputsDeleted: Number(outputsResult[0]?.numDeletedRows ?? 0n),
  };
}

/**
 * Build a per-tick handler for the orphan-secret-cleanup scheduled job.
 *
 * The cadence and the periodic wrapper itself live in
 * `packages/orchestrator/src/queue/scheduled-job.ts` — this factory
 * just produces the tick function. Success is logged only when rows
 * were actually deleted to keep the hourly log line noise-free on an
 * idle orchestrator.
 */
export function createOrphanSecretCleanupHandler(deps: SecretCleanupDeps): () => Promise<void> {
  const maxAgeHours = deps.maxAgeHours ?? 24;
  const logger = deps.logger;
  return async () => {
    try {
      const { keysDeleted, outputsDeleted } = await cleanupOrphanedSecrets(deps.db, maxAgeHours);
      if (keysDeleted > 0 || outputsDeleted > 0) {
        logger?.info('Cleaned up orphaned secret data', { keysDeleted, outputsDeleted });
      }
    } catch (err) {
      // Log and re-throw so the scheduler wrapper records the failure
      // metric + access-log row.
      logger?.warn('Failed to clean up orphaned secret data', {
        error: toErrorMessage(err),
      });
      throw err;
    }
  };
}
