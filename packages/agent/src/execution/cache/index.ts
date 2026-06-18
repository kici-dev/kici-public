/**
 * User-facing cache engine barrel (sandbox-side).
 *
 * Re-exports the pure pack/extract/checksum helpers and the imperative
 * `ctx.cache` API factory plus its transport interface.
 */
export {
  createCacheApi,
  packCachePaths,
  extractCacheTarball,
  downloadAndExtractCache,
  resolveCachePath,
  type CacheTransport,
  type CacheRoots,
} from './cache-engine.js';
export {
  restoreCacheSpecs,
  saveCacheSpecs,
  type CachePhaseDeps,
  type CacheRestoreOutcome,
} from './cache-phase.js';
