/**
 * Composable interfaces between the engine and provider-specific
 * implementations (GitHub, GitLab, Bitbucket), one per capability.
 */

export type { ProviderType } from './types.js';
export type { WebhookNormalizer } from './webhook-normalizer.js';
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
  CheckStatusPoster,
  CheckStatus,
  WorkflowModificationInfo,
} from './check-status-poster.js';
export * from './check-run-conclusion.js';
