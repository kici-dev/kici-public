/**
 * Backend registry for multi-source secret management.
 *
 * Manages the secret_backends table: CRUD operations, config encryption,
 * and factory methods to create SecretStore instances from registered backends.
 */
import { sql, type Kysely } from 'kysely';
import type {
  BackendDescriptor,
  BackendType,
  BackendHealthStatus,
  AddBackendParams,
  SecretStore,
} from '@kici-dev/engine';
import type { Logger } from '@kici-dev/shared';
import { encrypt, decrypt, type EncryptedValue } from '@kici-dev/shared';
import { PgSecretStore } from './pg-secret-store.js';
import { VaultSecretStore, type VaultConfig } from './vault-secret-store.js';
import type { AuditLogger } from './audit-logger.js';

/** Raw row shape from the secret_backends table. */
interface SecretBackendRow {
  id: string;
  name: string;
  backend_type: string;
  config_encrypted: string;
  config_key_version: number;
  scope_filter: string;
  sync_interval_ms: number;
  enabled: boolean;
  last_sync_at: Date | null;
  last_sync_error: string | null;
  last_health_check_at: Date | null;
  health_status: string;
  scope_count: number;
  created_at: Date;
  updated_at: Date;
}

/**
 * Map a DB row to a BackendDescriptor (no credentials).
 */
function rowToDescriptor(row: SecretBackendRow): BackendDescriptor {
  return {
    id: row.id,
    name: row.name,
    backendType: row.backend_type as BackendType,
    scopeFilter: row.scope_filter,
    syncIntervalMs: row.sync_interval_ms,
    enabled: row.enabled,
    healthStatus: row.health_status as BackendHealthStatus,
    scopeCount: row.scope_count,
    lastSyncAt: row.last_sync_at,
    lastSyncError: row.last_sync_error,
    lastHealthCheckAt: row.last_health_check_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Registry for secret backends.
 *
 * Encrypts backend config at rest using AES-256-GCM with the backend name
 * as AAD to prevent cross-backend config swaps.
 */
export class BackendRegistry {
  constructor(
    private readonly db: Kysely<any>,
    private readonly masterKey: Buffer,
    private readonly logger?: Logger,
    private readonly oldMasterKey?: Buffer,
  ) {}

  /**
   * Decrypt a backend config with the current master key, falling back to the
   * old key during a rotation grace window. Same dual-key pattern as
   * PgSecretStore.decryptWithFallback / ephemeral-keys.decryptPrivateKey. The
   * AAD stays `row.name` — ciphertext remains bound to its logical backend.
   * Never called for sentinel rows (config_encrypted = '').
   */
  private decryptConfigWithFallback(row: SecretBackendRow): {
    json: string;
    usedOldKey: boolean;
  } {
    const encrypted: EncryptedValue = {
      data: row.config_encrypted,
      keyVersion: row.config_key_version,
    };
    try {
      return { json: decrypt(encrypted, this.masterKey, row.name), usedOldKey: false };
    } catch {
      // Fall through to the old key (if configured) before failing loud.
      if (!this.oldMasterKey) throw this.strandedError(row.name);
    }
    try {
      return { json: decrypt(encrypted, this.oldMasterKey, row.name), usedOldKey: true };
    } catch {
      throw this.strandedError(row.name);
    }
  }

  /** Loud, recovery-pointing error for a backend stranded by key rotation. */
  private strandedError(name: string): Error {
    return new Error(
      `secret backend '${name}' cannot be decrypted with the configured master key(s). ` +
        `This usually means master-key rotation ran before backend configs were included in the sweep. ` +
        `Recovery: set KICI_SECRET_KEY_OLD (or secretKeyFileOld) to the previous key and restart — ` +
        `the backend will be re-encrypted automatically; as a last resort, ` +
        `'kici-admin backend purge-stale' deletes the stranded config so it can be re-added.`,
    );
  }

  /**
   * Re-seal a backend config that decrypted only under the old key back under
   * the current master key. Runs at load time while KICI_SECRET_KEY_OLD is
   * still configured, healing deployments that rotated before backend configs
   * were part of the rotation sweep. The concurrent-rotation guard
   * (`config_key_version` match) keeps a racing rotation from being clobbered.
   */
  private async selfHealStrandedRow(row: SecretBackendRow, json: string): Promise<void> {
    const resealed = encrypt(json, this.masterKey, row.config_key_version + 1, row.name);
    await this.db
      .updateTable('secret_backends')
      .set({
        config_encrypted: resealed.data,
        config_key_version: resealed.keyVersion,
        updated_at: sql`now()`,
      })
      .where('id', '=', row.id)
      .where('config_key_version', '=', row.config_key_version)
      .execute();
    this.logger?.warn(
      'secret backend config was sealed under the old master key — re-encrypted under the current key (self-heal)',
      { backend: row.name },
    );
  }

  /**
   * Register a new backend. Encrypts config and stores in DB.
   */
  async addBackend(params: AddBackendParams): Promise<BackendDescriptor> {
    const configJson = JSON.stringify(params.config);
    const encrypted = encrypt(configJson, this.masterKey, 1, params.name);

    const row = await this.db
      .insertInto('secret_backends')
      .values({
        name: params.name,
        backend_type: params.backendType,
        config_encrypted: encrypted.data,
        config_key_version: encrypted.keyVersion,
        scope_filter: params.scopeFilter ?? '**',
        sync_interval_ms: params.syncIntervalMs ?? 300000,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return rowToDescriptor(row as SecretBackendRow);
  }

  /**
   * Ensure the default `pg` backend row exists. The initial migration seeds
   * this row with `config_encrypted = ''` (sentinel, never decrypted), but the
   * row can be lost to operator error, a buggy purge, or manual cleanup.
   * Idempotent — safe to call on every startup. Self-heals DBs where the row
   * was deleted so the admin API and `listBackends()` always expose `pg`.
   */
  async ensureDefaultPgBackend(): Promise<void> {
    await this.db
      .insertInto('secret_backends')
      .values({
        name: 'pg',
        backend_type: 'pg',
        config_encrypted: '',
        scope_filter: '**',
      })
      .onConflict((oc) => oc.column('name').doNothing())
      .execute();
  }

  /**
   * Remove a backend by name. Returns true if a row was deleted.
   */
  async removeBackend(name: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('secret_backends')
      .where('name', '=', name)
      .executeTakeFirst();

    return (result?.numDeletedRows ?? 0n) > 0n;
  }

  /**
   * List all registered backends (metadata only, no credentials).
   */
  async listBackends(): Promise<BackendDescriptor[]> {
    const rows = await this.db
      .selectFrom('secret_backends')
      .selectAll()
      .orderBy('name', 'asc')
      .execute();

    return (rows as SecretBackendRow[]).map(rowToDescriptor);
  }

  /**
   * Get a single backend by name, or null if not found.
   */
  async getBackend(name: string): Promise<BackendDescriptor | null> {
    const row = await this.db
      .selectFrom('secret_backends')
      .selectAll()
      .where('name', '=', name)
      .executeTakeFirst();

    return row ? rowToDescriptor(row as SecretBackendRow) : null;
  }

  /**
   * Get backend config (decrypted). Internal use only.
   */
  async getBackendConfig(name: string): Promise<Record<string, unknown> | null> {
    const row = (await this.db
      .selectFrom('secret_backends')
      .selectAll()
      .where('name', '=', name)
      .executeTakeFirst()) as SecretBackendRow | undefined;

    if (!row) return null;

    if (!row.config_encrypted) return {};

    const { json } = this.decryptConfigWithFallback(row);
    return JSON.parse(json) as Record<string, unknown>;
  }

  /**
   * Create SecretStore instances for all enabled backends.
   * Returns a map of backend name to SecretStore.
   */
  async loadAllStores(auditLogger: AuditLogger): Promise<Map<string, SecretStore>> {
    const rows = (await this.db
      .selectFrom('secret_backends')
      .selectAll()
      .where('enabled', '=', true)
      .execute()) as SecretBackendRow[];

    const stores = new Map<string, SecretStore>();

    for (const row of rows) {
      let config: Record<string, unknown> = {};

      // PG backends reuse the orchestrator's own DB — no encrypted config needed.
      // The migration seeds them with config_encrypted = '' as a sentinel.
      if (row.config_encrypted) {
        const { json, usedOldKey } = this.decryptConfigWithFallback(row);
        config = JSON.parse(json);
        if (usedOldKey) {
          await this.selfHealStrandedRow(row, json);
        }
      }

      const store = this.createStoreForBackend(
        row.backend_type as BackendType,
        config,
        auditLogger,
      );
      if (store) {
        stores.set(row.name, store);
      }
    }

    return stores;
  }

  /**
   * Create a SecretStore for a given backend type and config.
   */
  createStoreForBackend(
    backendType: BackendType,
    config: Record<string, unknown>,
    auditLogger: AuditLogger,
  ): SecretStore | null {
    switch (backendType) {
      case 'pg': {
        // PG backend reuses the orchestrator's own DB connection + master key
        // The config may contain a separate connection string, but for the
        // default case we use the registry's own DB.
        return new PgSecretStore(this.db, this.masterKey, 1, auditLogger);
      }
      case 'vault': {
        const vaultLogger =
          this.logger ??
          ({
            debug: () => {},
            info: () => {},
            warn: () => {},
            error: () => {},
            child: () => vaultLogger,
          } as unknown as Logger);
        return new VaultSecretStore(config as unknown as VaultConfig, vaultLogger);
      }
      default:
        return null;
    }
  }

  /**
   * Update health status for a backend.
   */
  async updateHealthStatus(
    name: string,
    status: BackendHealthStatus,
    error?: string,
  ): Promise<void> {
    await this.db
      .updateTable('secret_backends')
      .set({
        health_status: status,
        last_health_check_at: sql`now()`,
        ...(error !== undefined ? { last_sync_error: error } : {}),
      })
      .where('name', '=', name)
      .execute();
  }

  /**
   * Update sync status for a backend.
   */
  async updateSyncStatus(name: string, scopeCount: number, error?: string): Promise<void> {
    await this.db
      .updateTable('secret_backends')
      .set({
        scope_count: scopeCount,
        last_sync_at: sql`now()`,
        last_sync_error: error ?? null,
      })
      .where('name', '=', name)
      .execute();
  }

  /**
   * Re-encrypt every non-sentinel backend config under the current master key
   * at max(config_key_version)+1. Same transactional skip-and-count shape as
   * SharedConfigStore.rotateKey — an undecryptable row is counted and left in
   * place (never aborts the sweep); recovery guidance lives in strandedError.
   * Sentinel rows (config_encrypted = '') are excluded from the candidate set
   * and never counted.
   */
  async rotateKey(): Promise<{ reEncrypted: number; skipped: number }> {
    let reEncrypted = 0;
    let skipped = 0;
    await this.db.transaction().execute(async (trx) => {
      const rows = (await trx
        .selectFrom('secret_backends')
        .selectAll()
        .where('config_encrypted', '!=', '')
        .execute()) as SecretBackendRow[];
      const newVersion = rows.reduce((m, r) => Math.max(m, r.config_key_version), 0) + 1;
      for (const row of rows) {
        // Defensive: a sentinel that slips past the SQL filter is never a
        // rotation candidate and must not be counted as skipped.
        if (!row.config_encrypted) continue;
        let json: string;
        try {
          json = this.decryptConfigWithFallback(row).json;
        } catch {
          skipped++;
          this.logger?.warn(
            'secret backend config undecryptable under both keys — skipped during rotation',
            { backend: row.name },
          );
          continue;
        }
        const resealed = encrypt(json, this.masterKey, newVersion, row.name);
        await trx
          .updateTable('secret_backends')
          .set({
            config_encrypted: resealed.data,
            config_key_version: newVersion,
            updated_at: sql`now()`,
          })
          .where('id', '=', row.id)
          .execute();
        reEncrypted++;
      }
    });
    return { reEncrypted, skipped };
  }
}
