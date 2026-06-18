/**
 * Cache module for customer-workflow source tarballs and dependency tarballs.
 *
 * SourceCache: content-hash-keyed storage for `.kici/` source tarballs
 *   (`source/{contentHash}.tar.gz`).
 * BuildCoordinator: deduplicates concurrent build requests.
 * DepCache: lockfileHash-keyed storage for dependency tarballs.
 */

export { SourceCache } from './source-cache.js';
export { BuildCoordinator } from './build-coordinator.js';
export { DepCache } from './dep-cache.js';
export {
  UserCache,
  DEFAULT_USER_CACHE_QUOTA_BYTES,
  DEFAULT_USER_CACHE_TTL_MS,
  type UserCacheRef,
  type UserCacheRestoreResult,
  type UserCacheBeginSaveResult,
  type UserCacheOrgLimits,
  type UserCacheOrgLimitsReader,
} from './user-cache.js';
export { DispatchCacheRefTracker, type DispatchCacheRef } from './dispatch-cache-ref-tracker.js';
export { PendingBuildTracker } from './pending-builds.js';
export { PendingInitTracker } from './pending-inits.js';
export type { InitResult } from './pending-inits.js';
export { PendingDynamicTracker } from './pending-dynamics.js';
