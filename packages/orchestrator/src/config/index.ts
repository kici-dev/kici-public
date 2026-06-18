/**
 * Barrel export for the orchestrator config module.
 *
 * Re-exports all types, schemas, and loader functions.
 */

// Types
export type { LocalConfig, SharedConfig, AppConfig, ConfigVersion } from './types.js';

// Schemas
export { localConfigSchema, sharedConfigSchema, appConfigSchema } from './schema.js';

export type {
  LocalConfigSchemaType,
  SharedConfigSchemaType,
  AppConfigSchemaType,
} from './schema.js';

// Loader
export { loadLocalConfig, SENSITIVE_FIELD_PATHS } from './loader.js';

// Shared config store
export { SharedConfigStore, type ConfigVersionMeta } from './shared-store.js';

// Encryption
export {
  encryptConfigFields,
  decryptConfigFields,
  redactConfigFields,
  resolveGlobPaths,
  deepGet,
  deepSet,
  REDACTED_VALUE,
} from './encryption.js';

// Env overlay
export {
  envKeyToConfigPath,
  applyEnvOverrides,
  deepMerge,
  deepSetByPath,
  deepGetByPath,
} from './env-overlay.js';

// Resolver
export {
  resolveLocalConfig,
  resolveFullConfig,
  getDefaults,
  type LocalPhaseResult,
} from './resolver.js';

// Hot-reload
export { ConfigReloader } from './reload.js';
export type { ConfigReloaderDeps, ReloadResult, ReloadOptions, ReloadSource } from './reload.js';
