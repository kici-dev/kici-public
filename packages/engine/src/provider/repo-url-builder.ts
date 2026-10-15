/** Builds provider-specific git clone and raw-file URLs for job dispatch. */

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
   */
  buildCloneUrl(repoIdentifier: string): string;

  /**
   * Build the raw file URL for a file at a ref (branch, tag, SHA); `path` is
   * relative to the repo root. Job dispatch uses it as `lockFileUrl`, so the
   * agent fetches the lock file without a full clone.
   */
  buildRawFileUrl(repoIdentifier: string, ref: string, path: string): string;
}
