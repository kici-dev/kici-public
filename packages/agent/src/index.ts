// Deployed application, not a library: server.ts imports internals directly, so
// re-export only what other packages need.

export { loadConfig, type AppConfig } from './config.js';
export { installDeps, type InstallDepsOptions } from './execution/dep-installer.js';
export { packNodeModules } from './execution/dep-packer.js';
export { restoreDeps } from './execution/dep-restore.js';
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
