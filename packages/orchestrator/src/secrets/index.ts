/**
 * Secrets management module.
 *
 * Re-exports the PG secret store, audit logger, crypto utilities,
 * and configuration helpers.
 */
export { PgSecretStore } from './pg-secret-store.js';
export { AuditLogger } from './audit-logger.js';
export {
  loadMasterKey,
  loadOldMasterKey,
  loadSecretStoreConfig,
  type SecretStoreConfig,
} from './config.js';
export { encrypt, decrypt, deriveKey, generateMasterKey, type EncryptedValue } from './crypto.js';
export { VaultSecretStore, type VaultConfig } from './vault-secret-store.js';
export {
  SecretResolver,
  type SecretResolverDeps,
  type ResolvedSecretMeta,
  type EnvironmentStoreLike,
  type BindingStoreLike,
  type SecretStoreLike,
} from './secret-resolver.js';
export { BackendSyncManager } from './backend-sync.js';
export { RbacEnforcer, PermissionDeniedError, type Role, type Permission } from './rbac.js';
export { TokenManager } from './token-manager.js';
export {
  cleanupOrphanedSecrets,
  createOrphanSecretCleanupHandler,
  type SecretCleanupDeps,
} from './cleanup.js';
