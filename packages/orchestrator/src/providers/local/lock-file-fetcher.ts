/**
 * Local filesystem lock file fetcher.
 *
 * Implements the LockFileFetcher interface from @kici-dev/engine by reading
 * kici.lock.json directly from the local filesystem. Used when the local
 * provider processes webhooks for repos accessible via file:// URLs.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LockFileFetcher, LockFile } from '@kici-dev/engine';
import { LockFileParseError } from '@kici-dev/engine';
import { createLogger, toErrorMessage } from '@kici-dev/shared';

const logger = createLogger({ prefix: 'local-lock-file' });

/**
 * Local provider implementation of LockFileFetcher.
 *
 * Reads kici.lock.json from the local filesystem at the path derived from
 * the repoIdentifier (which is expected to be a file:// URL or a local path).
 */
export class LocalLockFileFetcher implements LockFileFetcher {
  readonly provider = 'local' as const;

  /**
   * @param repoBasePath - Base directory for the repo(s). When repoIdentifier
   *   starts with 'file://', it is stripped and used as-is. Otherwise
   *   repoBasePath is used as the root.
   */
  constructor(private readonly repoBasePath: string) {}

  /**
   * Fetch the lock file from the local filesystem.
   *
   * @param repoIdentifier - Either a file:// URL or a relative path under repoBasePath
   * @param ref - Git ref (ignored for filesystem access -- always reads current state)
   * @param _credentials - Not used (file:// access needs no auth)
   * @returns Parsed LockFile, or null if not found
   * @throws LockFileParseError when the file is present but unparseable/invalid
   */
  async fetchLockFile(
    repoIdentifier: string,
    ref: string,
    _credentials: unknown,
  ): Promise<LockFile | null> {
    // Resolve the repo path
    let repoPath: string;
    if (repoIdentifier.startsWith('file://')) {
      repoPath = repoIdentifier.slice('file://'.length);
    } else {
      repoPath = join(this.repoBasePath, repoIdentifier);
    }

    const lockFilePath = join(repoPath, '.kici', 'kici.lock.json');

    // Read errors stay a benign miss (absent / unreadable -> null). Parse and
    // validation errors are a definitive corrupt lock -> throw LockFileParseError
    // so the resolver records a lock_resolution init failure (mirrors the GitHub
    // fetcher's absent-vs-corrupt split).
    let content: string;
    try {
      content = await readFile(lockFilePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.info('Lock file not found', { lockFilePath });
        return null;
      }
      logger.error('Failed to read lock file', {
        lockFilePath,
        error: toErrorMessage(err),
      });
      return null;
    }

    let lockFile: LockFile;
    try {
      lockFile = JSON.parse(content) as LockFile;
    } catch (err) {
      throw new LockFileParseError(
        repoIdentifier,
        ref,
        `Lock file at ${lockFilePath} is not valid JSON: ${(err as Error).message}`,
      );
    }

    // Basic shape validation
    if (typeof lockFile.schemaVersion !== 'number') {
      throw new LockFileParseError(
        repoIdentifier,
        ref,
        `Invalid lock file at ${lockFilePath}: missing or invalid schemaVersion`,
      );
    }

    logger.info('Lock file fetched from filesystem', {
      lockFilePath,
      schemaVersion: lockFile.schemaVersion,
      workflowCount: lockFile.workflows.length,
    });

    return lockFile;
  }
}
