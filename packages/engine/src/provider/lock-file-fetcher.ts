/**
 * Fetches kici.lock.json from a provider's repository API, so the orchestrator
 * evaluates triggers without cloning the repo.
 */

import type { LockFile } from '../trigger/types.js';
import type { ProviderType } from './types.js';

export interface LockFileFetcher {
  readonly provider: ProviderType;

  /**
   * Whether a fetched lock file may be cached under `{repoIdentifier}:{ref}`;
   * omitted means yes. A fetcher whose content can change under a fixed ref (a
   * local working tree read from disk) sets `false`, so every lookup reads the
   * current file.
   */
  readonly cacheable?: boolean;

  /**
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
