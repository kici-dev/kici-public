/**
 * Local filesystem repo URL builder.
 *
 * Implements the RepoUrlBuilder interface from @kici-dev/engine by returning
 * file:// URLs for local filesystem access, or network URLs (git://, http://)
 * when a cloneUrlBase is configured for remote agent support.
 */

import type { RepoUrlBuilder } from '@kici-dev/engine';

/**
 * Local provider implementation of RepoUrlBuilder.
 *
 * Builds clone URLs for repository access. When cloneUrlBase is set (e.g. to
 * a git:// daemon URL), uses it for clone URLs so remote agents on different
 * machines can clone. Otherwise falls back to file:// URLs for local access.
 */
export class LocalRepoUrlBuilder implements RepoUrlBuilder {
  readonly provider = 'local' as const;

  /**
   * @param repoBasePath - Base directory where test repos live on disk
   * @param cloneUrlBase - Optional URL base for clone operations (e.g. git://host/path).
   *   When set, overrides the default file:// URL construction.
   */
  constructor(
    private readonly repoBasePath: string,
    private readonly cloneUrlBase?: string,
  ) {}

  /**
   * Build a clone URL for a repo.
   *
   * If cloneUrlBase is set, uses it directly (for remote agents).
   * If repoIdentifier already starts with 'file://', returns it as-is.
   * Otherwise, prepends 'file://' and the repoBasePath.
   */
  buildCloneUrl(repoIdentifier: string): string {
    // Network-accessible clone URL configured (e.g. git daemon)
    if (this.cloneUrlBase) {
      if (repoIdentifier === '.') {
        return this.cloneUrlBase;
      }
      return `${this.cloneUrlBase.replace(/\/$/, '')}/${repoIdentifier}`;
    }

    if (repoIdentifier.startsWith('file://')) {
      return repoIdentifier;
    }
    // On Windows, file:// URLs must use three slashes and forward slashes:
    // file:///C:/path/to/repo (not file://C:\path which treats C: as hostname)
    const basePath = this.repoBasePath.replace(/\\/g, '/');
    const prefix = basePath.match(/^[A-Za-z]:/) ? 'file:///' : 'file://';
    if (repoIdentifier === '.') {
      return `${prefix}${basePath}`;
    }
    return `${prefix}${basePath}/${repoIdentifier}`;
  }

  /**
   * Build a raw file URL -- returns empty string.
   *
   * Local repos have no web UI, so raw file URLs are not applicable.
   * The lock file is fetched via LocalLockFileFetcher (filesystem) instead.
   */
  buildRawFileUrl(_repoIdentifier: string, _ref: string, _path: string): string {
    return '';
  }
}
