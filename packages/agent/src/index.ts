// Agent package — deployed application, not a library.
// Internal modules are imported directly by server.ts.
// Only re-export types/symbols needed by other packages.

export { loadConfig, type AppConfig } from './config.js';
export { installDeps, type InstallDepsOptions } from './execution/dep-installer.js';
export {
  findLocalProtocolDeps,
  assertResolvableDeps,
  formatUnresolvableDepError,
  kiciHasLocalProtocolDeps,
  LocalDepProtocol,
  type LocalProtocolDep,
} from './execution/validate-kici-deps.js';
export {
  createCacheApi,
  packCachePaths,
  extractCacheTarball,
  downloadAndExtractCache,
  resolveCachePath,
  type CacheTransport,
  type CacheRoots,
} from './execution/cache/index.js';
