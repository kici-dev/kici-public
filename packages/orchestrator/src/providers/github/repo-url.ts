/**
 * GitHub repository URL builder.
 *
 * Implements the RepoUrlBuilder interface from @kici-dev/engine for GitHub.
 * Constructs HTTPS clone URLs and raw file access URLs on the GitHub server
 * the source's App lives on.
 */

import type { RepoUrlBuilder } from '@kici-dev/engine';
import { DEFAULT_GITHUB_URL } from './github-host.js';

/**
 * GitHub-specific implementation of RepoUrlBuilder.
 *
 * Builds URLs on github.com, or on the GitHub Enterprise Server named by
 * `githubUrl`. repoIdentifier is expected in "owner/repo" format.
 */
export class GitHubRepoUrlBuilder implements RepoUrlBuilder {
  readonly provider = 'github' as const;

  /** @param githubUrl - Web URL of the App's server; github.com when unset. */
  constructor(private readonly githubUrl: string = DEFAULT_GITHUB_URL) {}

  /**
   * Build the HTTPS clone URL for a GitHub repository.
   *
   * @param repoIdentifier - "owner/repo" format
   * @returns <githubUrl>/owner/repo.git
   */
  buildCloneUrl(repoIdentifier: string): string {
    return `${this.githubUrl}/${repoIdentifier}.git`;
  }

  /**
   * Build the raw file URL for a file at a specific ref.
   *
   * Uses GitHub's raw endpoint for direct file access.
   *
   * @param repoIdentifier - "owner/repo" format
   * @param ref - Git ref (branch, tag, SHA)
   * @param path - File path relative to repo root
   * @returns <githubUrl>/owner/repo/raw/ref/path
   */
  buildRawFileUrl(repoIdentifier: string, ref: string, path: string): string {
    return `${this.githubUrl}/${repoIdentifier}/raw/${ref}/${path}`;
  }
}
