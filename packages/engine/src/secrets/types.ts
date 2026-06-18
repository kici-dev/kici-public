/**
 * Secrets management interfaces for KiCI.
 *
 * Defines the pluggable backend contract (SecretStore) and audit logging
 * (AuditEntry) for the scoped secrets system.
 *
 * These interfaces are backend-agnostic -- implementations live in
 * orchestrator (PG backend) or can be swapped for Vault, etc.
 */

/**
 * Scope-based secret store interface.
 * Provides access to secrets organized by (orgId, scope, key).
 */
export interface SecretStore {
  /** Get all secrets for a scope as decrypted key-value pairs. */
  getSecrets(orgId: string, scope: string): Promise<Record<string, string>>;
  /** Set (create or update) a secret in a scope. */
  setSecret(orgId: string, scope: string, key: string, value: string): Promise<void>;
  /** Delete a secret from a scope. */
  deleteSecret(orgId: string, scope: string, key: string): Promise<void>;
  /** List all secret key names in a scope (no values returned). */
  listKeys(orgId: string, scope: string): Promise<string[]>;
  /** List all distinct scopes for an org. */
  listScopes(orgId: string): Promise<string[]>;
  /** Create an empty scope (implementation may use a sentinel row or metadata table). */
  createScope?(orgId: string, scope: string): Promise<void>;
  /** Rename a scope -- update all secret rows from oldScope to newScope. */
  renameScope?(orgId: string, oldScope: string, newScope: string): Promise<void>;
  /** Delete a scope and all its secrets. */
  deleteScope?(orgId: string, scope: string): Promise<void>;
  /** Get all secrets for an org (for resolver). Returns encrypted values. */
  getAllSecrets(
    orgId: string,
  ): Promise<Array<{ scope: string; key: string; encryptedValue: string; keyVersion: number }>>;
}

// ── Multi-source backend types ──────────────────────────────────

/** Supported secret backend types. */
export type BackendType = 'pg' | 'vault';

/** Health status of a secret backend. */
export type BackendHealthStatus = 'healthy' | 'degraded' | 'unreachable' | 'unknown';

/**
 * Metadata descriptor for a registered secret backend.
 * Does NOT include credentials — safe to expose via API.
 */
export interface BackendDescriptor {
  id: string;
  name: string;
  backendType: BackendType;
  /** Comma-separated globs for scope filtering. Default '**'. */
  scopeFilter: string;
  /** Sync interval in milliseconds. Default 300000 (5 min). */
  syncIntervalMs: number;
  enabled: boolean;
  healthStatus: BackendHealthStatus;
  scopeCount: number;
  lastSyncAt: Date | null;
  lastSyncError: string | null;
  lastHealthCheckAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Parameters for registering a new secret backend. */
export interface AddBackendParams {
  name: string;
  backendType: BackendType;
  config: Record<string, unknown>;
  scopeFilter?: string;
  syncIntervalMs?: number;
}

/**
 * Backend lifecycle manager interface.
 * Provides CRUD, health checks, and connection testing for secret backends.
 */
export interface BackendManager {
  /** Check backend connectivity. Returns health status. */
  checkHealth(name: string): Promise<BackendHealthStatus>;
  /** Trigger scope discovery sync for a backend (or all if name omitted). */
  syncScopes(name?: string): Promise<void>;
  /** List all registered backends (no credentials). */
  listBackends(): Promise<BackendDescriptor[]>;
  /** Get a single backend by name. */
  getBackend(name: string): Promise<BackendDescriptor | null>;
  /** Register a new backend. Returns the descriptor. */
  addBackend(params: AddBackendParams): Promise<BackendDescriptor>;
  /** Remove a backend by name. Returns true if removed. */
  removeBackend(name: string): Promise<boolean>;
  /** Test connectivity without persisting. */
  testConnection(
    params: AddBackendParams,
  ): Promise<{ ok: boolean; error?: string; latencyMs: number }>;
}

/**
 * Periodic scope sync manager for secret backends.
 */
export interface BackendSyncManager {
  syncBackend(name: string): Promise<{ scopeCount: number; error?: string }>;
  syncAllBackends(): Promise<Array<{ name: string; scopeCount: number; error?: string }>>;
  startPeriodicSync(): void;
  stopPeriodicSync(): void;
}

/**
 * Audit log entry for secrets operations.
 * Used for tracking access patterns and security events.
 */
export interface AuditEntry {
  /** The action performed (e.g., 'getSecrets', 'setSecret', 'resolve'). */
  action: string;
  /** The scope or context name involved. */
  contextName: string;
  /** Routing key scope. */
  routingKey: string | null;
  /** Secret keys involved (null for scope-level ops). */
  secretKeys: string[] | null;
  /** Whether the operation was allowed or denied. */
  outcome: 'allowed' | 'denied';
  /** CI run ID if applicable. */
  runId: string | null;
  /** Job ID if applicable. */
  jobId: string | null;
  /** User ID if applicable. */
  userId: string | null;
  /** User role if applicable. */
  role: string | null;
  /** Additional metadata. */
  metadata: Record<string, unknown> | null;
}
