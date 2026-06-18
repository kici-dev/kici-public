/**
 * GitHub provider implementations for KiCI.
 *
 * Each class implements a corresponding interface from @kici-dev/engine:
 * - GitHubWebhookNormalizer -> WebhookNormalizer
 * - GitHubLockFileFetcher -> LockFileFetcher
 * - GitHubChangedFilesFetcher -> ChangedFilesFetcher
 * - GitHubCloneTokenProvider -> CloneTokenProvider
 * - GitHubRepoUrlBuilder -> RepoUrlBuilder
 * - GitHubContributorResolver -> ContributorResolver
 */

export { GitHubWebhookNormalizer } from './normalizer.js';
export { GitHubLockFileFetcher } from './lock-file.js';
export { GitHubChangedFilesFetcher } from './changed-files.js';
export { GitHubCloneTokenProvider, createInstallationOctokit } from './auth.js';
export type { GitHubAppConfig, GitHubCredentials } from './auth.js';
export { GitHubRepoUrlBuilder } from './repo-url.js';
export { GitHubContributorResolver } from './contributor-resolver.js';
export { GitHubCheckStatusPoster } from './check-status-poster.js';
