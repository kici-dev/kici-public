// Orchestrator package entry point
//
// The orchestrator is a deployed application, not a library.
// Only symbols with actual external consumers are exported here.

// Storage and cache (exported for tests that drive real object storage)
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

// Cluster peer credentials (exported for tests that drive a real database)
export {
  PeerCredentialStore,
  createPeerCredentialStoreFromUrl,
  type PeerCredential,
  type CredentialFileData,
} from './cluster/peer-credentials.js';

// Peer auth coordinator (exported for cluster tests)
export {
  PeerAuthCoordinator,
  type AuthDecision,
  type RejectionAction,
} from './cluster/peer-auth-coordinator.js';

// Cluster join-token manager (exported for tests that drive a real database)
export { JoinTokenManager, createJoinTokenManagerFromUrl } from './cluster/join-token.js';

// Held-run store (exported for tests that exercise PR-scoped hold selection).
// `SecurityHoldReason` travels with it so a test asserting on a persisted
// `held_runs.reason` compares against the writer's own vocabulary rather than a
// bare string literal.
export {
  HeldRunStore,
  createHeldRunStoreFromUrl,
  SecurityHoldReason,
} from './contexts/held-runs.js';
export {
  TrustPolicyStore,
  createTrustPolicyStoreFromUrl,
  TrustPolicySource,
  DEFAULT_TRUST_POLICY,
  type StoredTrustPolicy,
} from './security/trust-policy-store.js';

// Admin API client + GitHub App manifest setup (exported for tests that drive
// the one-click setup orchestration against a running orchestrator with the
// GitHub API boundary stubbed).
export { AdminApiClient } from './cli/api-client.js';
export {
  runGithubManifestSetup,
  type ManifestSetupOptions,
  type ManifestSetupDeps,
} from './cli/commands/source-manifest.js';
