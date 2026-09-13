/**
 * RepoUrlBuilder interface.
 *
 * Constructs provider-specific URLs for repository operations.
 * Used for git clone URLs and raw file access URLs in job dispatch.
 */

import type { ProviderType } from './types.js';

export interface RepoUrlBuilder {
  readonly provider: ProviderType;

  /**
   * Build the HTTPS clone URL for a repo.
   *
   * Examples:
   * - GitHub: https://github.com/owner/repo.git
   * - GitLab: https://gitlab.com/namespace/project.git
   * - Bitbucket: https://bitbucket.org/workspace/repo.git
   *
   * @param repoIdentifier - Provider-specific repo identifier
   * @returns HTTPS clone URL
   */
  buildCloneUrl(repoIdentifier: string): string;

  /**
   * Build the raw file URL for a file at a specific ref.
   *
   * Used for lockFileUrl in job dispatch, allowing the agent to
   * fetch the lock file without a full clone.
   *
   * @param repoIdentifier - Provider-specific repo identifier
   * @param ref - Git ref (branch, tag, SHA)
   * @param path - File path relative to repo root
   * @returns Direct URL to the raw file content
   */
  buildRawFileUrl(repoIdentifier: string, ref: string, path: string): string;
}
