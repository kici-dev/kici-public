/**
 * Backend-agnostic contracts for scoped secrets: the pluggable store
 * (SecretStore; the orchestrator implements PG, swappable for Vault, etc.) and
 * audit logging (AuditEntry).
 */

/** Secret store keyed by (orgId, scope, key). */
export interface SecretStore {
  /** Decrypted key-value pairs. */
  getSecrets(orgId: string, scope: string): Promise<Record<string, string>>;
  /** Create or update. */
  setSecret(orgId: string, scope: string, key: string, value: string): Promise<void>;
  deleteSecret(orgId: string, scope: string, key: string): Promise<void>;
  /** Key names only, no values. */
  listKeys(orgId: string, scope: string): Promise<string[]>;
  listScopes(orgId: string): Promise<string[]>;
  /** Create an empty scope (e.g. a sentinel row or metadata table). */
  createScope?(orgId: string, scope: string): Promise<void>;
  /** Moves every secret row from oldScope to newScope. */
  renameScope?(orgId: string, oldScope: string, newScope: string): Promise<void>;
  /** Deletes the scope's secrets too. */
  deleteScope?(orgId: string, scope: string): Promise<void>;
  /** Every secret in the org, still encrypted (for the resolver). */
  getAllSecrets(
    orgId: string,
  ): Promise<Array<{ scope: string; key: string; encryptedValue: string; keyVersion: number }>>;
}

// ── Multi-source backend types ──────────────────────────────────

export type BackendType = 'pg' | 'vault';

export type BackendHealthStatus = 'healthy' | 'degraded' | 'unreachable' | 'unknown';

/** A registered secret backend's metadata: NO credentials, so safe to expose via API. */
export interface BackendDescriptor {
  id: string;
  name: string;
  backendType: BackendType;
  /** Comma-separated globs for scope filtering. Default '**'. */
  scopeFilter: string;
  /** Default 300000 (5 min). */
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

export interface AddBackendParams {
  name: string;
  backendType: BackendType;
  config: Record<string, unknown>;
  scopeFilter?: string;
  syncIntervalMs?: number;
}

/** Periodic scope sync for secret backends. */
export interface BackendSyncManager {
  syncBackend(name: string): Promise<{ scopeCount: number; error?: string }>;
  syncAllBackends(): Promise<Array<{ name: string; scopeCount: number; error?: string }>>;
  startPeriodicSync(): void;
  stopPeriodicSync(): void;
}

/** Audit log entry for a secrets operation (access patterns, security events). */
export interface AuditEntry {
  /** The action performed (e.g., 'getSecrets', 'setSecret', 'resolve'). */
  action: string;
  /** The scope or context name involved. */
  contextName: string;
  routingKey: string | null;
  /** Secret keys involved (null for scope-level ops). */
  secretKeys: string[] | null;
  outcome: 'allowed' | 'denied';
  runId: string | null;
  jobId: string | null;
  userId: string | null;
  role: string | null;
  metadata: Record<string, unknown> | null;
}
