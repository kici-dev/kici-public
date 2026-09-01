/**
 * Provider abstraction interfaces for KiCI.
 *
 * Composable interfaces that define the contract between the engine
 * and provider-specific implementations (GitHub, GitLab, Bitbucket).
 *
 * Each interface covers a distinct capability:
 * - WebhookNormalizer: Webhook ingestion and event normalization
 * - LockFileFetcher: Repository API access for lock files
 * - ChangedFilesFetcher: Repository API access for changed files
 * - FileContentsFetcher: Repository API access for arbitrary file contents
 * - CloneTokenProvider: Auth token generation for agent clone
 * - RepoUrlBuilder: Provider-specific URL construction
 */

export type { ProviderType } from './types.js';
export type { WebhookNormalizer, AccessCacheInvalidation } from './webhook-normalizer.js';
export type { LockFileFetcher } from './lock-file-fetcher.js';
export { LockFileParseError } from './lock-file-parse-error.js';
export type { ChangedFilesFetcher, ChangedFilesResult } from './changed-files-fetcher.js';
export type { FileContentsFetcher } from './file-contents-fetcher.js';
export type { CloneTokenProvider, ProviderGitAuth } from './clone-token-provider.js';
export type {
  ForgeName,
  Sourced,
  GitCredentialRef,
  GitCredentialGrant,
  GitCredentialRequest,
  GitCredentialResult,
} from './git-credential.js';
export { isMintedRef } from './git-credential.js';
export type { RepoUrlBuilder } from './repo-url-builder.js';
export type {
  ContributorResolver,
  ContributorInfo,
  ContributorPermission,
} from './contributor-resolver.js';
export type {
  CheckStatusPoster,
  CheckStatus,
  WorkflowModificationInfo,
} from './check-status-poster.js';
export * from './check-run-conclusion.js';
