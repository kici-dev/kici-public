// Orchestrator package entry point
//
// The orchestrator is a deployed application, not a library.
// Only symbols with actual external consumers are exported here.

// Storage and cache (consumed by e2e tests)
export type { CacheStorage, CacheStorageConfig, CacheMetadata } from './storage/types.js';
export { S3CacheStorage, type S3CacheStorageOptions } from './storage/s3.js';
export { createCacheStorage } from './storage/index.js';
export { SourceCache } from './cache/source-cache.js';
export { DepCache } from './cache/dep-cache.js';
export {
  UserCache,
  DEFAULT_USER_CACHE_QUOTA_BYTES,
  DEFAULT_USER_CACHE_TTL_MS,
  type UserCacheRef,
  type UserCacheRestoreResult,
  type UserCacheBeginSaveResult,
} from './cache/user-cache.js';

// Cluster peer credentials (consumed by e2e tests)
export {
  PeerCredentialStore,
  createPeerCredentialStoreFromUrl,
  type PeerCredential,
  type CredentialFileData,
} from './cluster/peer-credentials.js';

// Peer auth coordinator (consumed by e2e cluster tests)
export {
  PeerAuthCoordinator,
  type AuthDecision,
  type RejectionAction,
} from './cluster/peer-auth-coordinator.js';

// Cluster join-token manager (consumed by e2e tests)
export { JoinTokenManager, createJoinTokenManagerFromUrl } from './cluster/join-token.js';

// Admin API client + GitHub App manifest setup (consumed by e2e tests that
// drive the one-click setup orchestration against a deployed orchestrator with
// the GitHub API boundary stubbed).
export { AdminApiClient } from './cli/api-client.js';
export {
  runGithubManifestSetup,
  type ManifestSetupOptions,
  type ManifestSetupDeps,
} from './cli/commands/source-manifest.js';
