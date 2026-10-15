/** Sandbox-side cache engine barrel, including the `ctx.cache` API factory. */
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
  createCacheStepIndexAllocator,
  JOB_CACHE_OWNER,
  type CachePhaseDeps,
  type CacheRestoreOutcome,
} from './cache-phase.js';
