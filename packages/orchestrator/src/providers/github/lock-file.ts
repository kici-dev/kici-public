/**
 * GitHub lock file fetcher.
 *
 * Implements the LockFileFetcher interface from @kici-dev/engine for GitHub.
 * Fetches kici.lock.json from a GitHub repository via the Contents API.
 *
 * NOTE: This is the raw fetcher without caching. The orchestrator wraps
 * this with an LRU cache (LockFileCache) for production use.
 */

import { LockFileParseError, type LockFileFetcher, type LockFile } from '@kici-dev/engine';
import { createInstallationOctokit, type GitHubAppConfig, type GitHubCredentials } from './auth.js';

/**
 * GitHub-specific implementation of LockFileFetcher.
 *
 * Fetches .kici/kici.lock.json from a GitHub repository using the Contents API.
 * Does NOT include caching -- the orchestrator wraps this fetcher with an LRU cache.
 */
export class GitHubLockFileFetcher implements LockFileFetcher {
  readonly provider = 'github' as const;

  constructor(private readonly config: GitHubAppConfig) {}

  /**
   * Fetch the lock file from a GitHub repository at a specific ref.
   *
   * @param repoIdentifier - "owner/repo" format
   * @param ref - Git ref (branch, tag, SHA)
   * @param credentials - Must be GitHubCredentials with installationId
   * @returns Parsed LockFile, or null if not found
   */
  async fetchLockFile(
    repoIdentifier: string,
    ref: string,
    credentials: unknown,
  ): Promise<LockFile | null> {
    const { installationId } = credentials as GitHubCredentials;
    const [owner, repo] = repoIdentifier.split('/');

    const octokit = createInstallationOctokit(this.config, installationId);

    // Build the URL manually because Octokit's template expansion URL-encodes
    // the `{path}` parameter, turning `.kici/kici.lock.json` into
    // `.kici%2Fkici.lock.json` which GitHub's Contents API rejects with 404.
    let data: { sha: string; content?: string; encoding?: string };
    try {
      const url = `GET /repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/.kici/kici.lock.json`;
      const response = await octokit.request(url, { ref });

      // Directory listing -- not a file
      if (Array.isArray(response.data)) {
        return null;
      }

      data = response.data as { sha: string; content?: string; encoding?: string };
    } catch (error: unknown) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }

    if (!data.content) {
      throw new LockFileParseError(
        repoIdentifier,
        ref,
        `Lock file at ${repoIdentifier} ref=${ref} has no content`,
      );
    }

    const decoded = Buffer.from(data.content, 'base64').toString('utf-8');
    let lockFile: LockFile;
    try {
      lockFile = JSON.parse(decoded) as LockFile;
    } catch (err) {
      throw new LockFileParseError(
        repoIdentifier,
        ref,
        `Lock file at ${repoIdentifier} ref=${ref} is not valid JSON: ${(err as Error).message}`,
      );
    }

    // Basic shape validation
    if (typeof lockFile.schemaVersion !== 'number') {
      throw new LockFileParseError(
        repoIdentifier,
        ref,
        `Invalid lock file at ${repoIdentifier}: missing or invalid schemaVersion`,
      );
    }

    return lockFile;
  }
}

/**
 * Check if an error is a GitHub 404 (Not Found) response.
 */
function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status: number }).status === 404
  );
}
