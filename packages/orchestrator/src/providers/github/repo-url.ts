/**
 * GitHub repository URL builder.
 *
 * Implements the RepoUrlBuilder interface from @kici-dev/engine for GitHub.
 * Constructs HTTPS clone URLs and raw file access URLs.
 */

import type { RepoUrlBuilder } from '@kici-dev/engine';

/**
 * GitHub-specific implementation of RepoUrlBuilder.
 *
 * Builds URLs for github.com repositories.
 * repoIdentifier is expected in "owner/repo" format.
 */
export class GitHubRepoUrlBuilder implements RepoUrlBuilder {
  readonly provider = 'github' as const;

  /**
   * Build the HTTPS clone URL for a GitHub repository.
   *
   * @param repoIdentifier - "owner/repo" format
   * @returns https://github.com/owner/repo.git
   */
  buildCloneUrl(repoIdentifier: string): string {
    return `https://github.com/${repoIdentifier}.git`;
  }

  /**
   * Build the raw file URL for a file at a specific ref.
   *
   * Uses GitHub's raw endpoint for direct file access.
   *
   * @param repoIdentifier - "owner/repo" format
   * @param ref - Git ref (branch, tag, SHA)
   * @param path - File path relative to repo root
   * @returns https://github.com/owner/repo/raw/ref/path
   */
  buildRawFileUrl(repoIdentifier: string, ref: string, path: string): string {
    return `https://github.com/${repoIdentifier}/raw/${ref}/${path}`;
  }
}
