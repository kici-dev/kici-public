/**
 * Secrets management module.
 *
 * Re-exports scope-based secret store types and audit entry.
 */
export type {
  SecretStore,
  AuditEntry,
  BackendType,
  BackendHealthStatus,
  BackendDescriptor,
  AddBackendParams,
  BackendManager,
  BackendSyncManager,
} from './types.js';
