/**
 * Local filesystem (`file://`) source provider implementations.
 *
 * Provides a complete provider bundle for cloning a git repository that is
 * already present on the agent's filesystem, with no remote forge, no webhook
 * signature verification, and no network clone. Uses file:// URLs for cloning
 * and reads lock files directly from the filesystem.
 *
 * Classes:
 * - LocalWebhookNormalizer -> WebhookNormalizer (extracts from custom headers)
 * - LocalLockFileFetcher -> LockFileFetcher (reads from local filesystem)
 * - LocalRepoUrlBuilder -> RepoUrlBuilder (returns file:// URLs)
 */

import type { ProviderBundle } from '../../provider-registry.js';
import { LocalWebhookNormalizer } from './normalizer.js';
import { LocalLockFileFetcher } from './lock-file-fetcher.js';
import { LocalRepoUrlBuilder } from './repo-url-builder.js';

export { LocalWebhookNormalizer } from './normalizer.js';
export { LocalLockFileFetcher } from './lock-file-fetcher.js';
export { LocalRepoUrlBuilder } from './repo-url-builder.js';

/**
 * Create a ProviderBundle for a local filesystem (`file://`) source.
 *
 * Provides normalizer, lock file fetcher, and repo URL builder.
 * Clone token provider and changed files fetcher are null since
 * file:// URLs need no auth and local events don't track changed files.
 *
 * @param opts.repoBasePath - Base directory where the repo(s) live on disk
 * @param opts.cloneUrlBase - Optional URL base for clone operations (e.g. git://host/path)
 * @returns Complete ProviderBundle for the local provider
 */
export function createLocalProviderBundle(opts: {
  repoBasePath: string;
  cloneUrlBase?: string;
}): ProviderBundle {
  return {
    normalizer: new LocalWebhookNormalizer(),
    lockFileFetcher: new LocalLockFileFetcher(opts.repoBasePath),
    repoUrlBuilder: new LocalRepoUrlBuilder(opts.repoBasePath, opts.cloneUrlBase),
    // file:// URLs don't need auth tokens
    cloneTokenProvider: undefined,
    // Local events don't track changed files -- triggers match on branch/event only
    changedFilesFetcher: undefined,
  };
}
