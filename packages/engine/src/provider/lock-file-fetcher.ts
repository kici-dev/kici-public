/**
 * LockFileFetcher interface.
 *
 * Fetches kici.lock.json from a provider's repository API.
 * Used by the orchestrator to evaluate triggers without cloning the repo.
 */

import type { LockFile } from '../trigger/types.js';
import type { ProviderType } from './types.js';

export interface LockFileFetcher {
  readonly provider: ProviderType;

  /**
   * Fetch the lock file content for a repo at a specific ref.
   *
   * Implementation details (API client, caching, auth) are internal
   * to each provider. The interface only cares about the result.
   *
   * @param repoIdentifier - Provider-specific repo identifier (e.g., "owner/repo" for GitHub)
   * @param ref - Git ref (branch name, tag, or SHA)
   * @param credentials - Provider-specific auth credentials
   * @returns Parsed lock file, or null if not found
   */
  fetchLockFile(
    repoIdentifier: string,
    ref: string,
    credentials: unknown,
  ): Promise<LockFile | null>;
}
