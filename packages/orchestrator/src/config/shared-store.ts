/**
 * Database-backed shared configuration store with versioning.
 *
 * Provides CRUD operations for orchestrator shared configuration stored
 * in the config_versions PostgreSQL table. Each save creates a new immutable
 * version with audit trail. Sensitive fields are encrypted at rest using
 * AES-256-GCM via the master key.
 *
 * Key operations:
 * - getLatest(): retrieve current config (decrypted)
 * - getByVersion(): retrieve a specific version
 * - save(): validate, encrypt sensitive fields, store new version
 * - rollback(): copy a previous version as a new version
 * - listHistory(): version audit trail (metadata only)
 * - getCurrentVersion(): current version number (for cluster heartbeat)
 * - exportRedacted(): config with sensitive fields masked
 */
import { sql, type Kysely } from 'kysely';
import { createLogger } from '@kici-dev/shared';
import type { Database, ConfigVersionRow } from '../db/types.js';
import { sharedConfigSchema } from './schema.js';
import type { SharedConfig } from './types.js';
import { SENSITIVE_FIELD_PATHS } from './loader.js';
import { encryptConfigFields, decryptConfigFields, redactConfigFields } from './encryption.js';

const logger = createLogger({ prefix: 'shared-config-store' });

/**
 * Version metadata returned by listHistory().
 */
export interface ConfigVersionMeta {
  version: number;
  createdAt: Date;
  createdBy: string;
  description: string | null;
}

/**
 * Database-backed shared configuration store with versioning, encryption, and audit trail.
 */
export class SharedConfigStore {
  /**
   * Active master-key generation. New inserts stamp this value into
   * `config_versions.key_version`; rotation bumps it after re-encrypting
   * every row in a single transaction.
   */
  private keyVersion: number;

  constructor(
    private db: Kysely<Database>,
    private masterKey: Buffer | null,
    /** Previous master key, accepted during the rotation grace window. */
    private oldMasterKey: Buffer | null = null,
    keyVersion: number = 1,
  ) {
    this.keyVersion = keyVersion;
  }

  /**
   * Construct a `SharedConfigStore` with the active key generation hydrated
   * from the database.
   *
   * Mirrors `PgSecretStore.create`: reads `MAX(key_version)` from
   * `config_versions` so a freshly-restarted orchestrator keeps writing under
   * the same generation as the last row committed before shutdown. Empty
   * tables fall back to generation 1.
   */
  static async create(
    db: Kysely<Database>,
    masterKey: Buffer | null,
    oldMasterKey?: Buffer | null,
  ): Promise<SharedConfigStore> {
    const result = await db
      .selectFrom('config_versions')
      .select(sql<number>`COALESCE(MAX(key_version), 1)`.as('max_version'))
      .executeTakeFirst();
    const keyVersion = result?.max_version ?? 1;
    return new SharedConfigStore(db, masterKey, oldMasterKey ?? null, keyVersion);
  }

  /**
   * Get the latest config version (decrypt if master key available).
   * Returns null if no config versions exist.
   */
  async getLatest(): Promise<{ config: SharedConfig; version: number } | null> {
    const row = await this.db
      .selectFrom('config_versions')
      .selectAll()
      .orderBy('version', 'desc')
      .limit(1)
      .executeTakeFirst();

    if (!row) return null;
    return this.rowToConfig(row);
  }

  /**
   * Get a specific config version by version number.
   * Returns null if the version doesn't exist.
   */
  async getByVersion(version: number): Promise<{ config: SharedConfig; version: number } | null> {
    const row = await this.db
      .selectFrom('config_versions')
      .selectAll()
      .where('version', '=', version)
      .executeTakeFirst();

    if (!row) return null;
    return this.rowToConfig(row);
  }

  /**
   * Save a new config version.
   * Validates with sharedConfigSchema, encrypts sensitive fields,
   * and stores as a new immutable version.
   *
   * @param config - The config object to save
   * @param createdBy - Who created this version (e.g., "cli:seed", "api:set")
   * @param description - Human-readable change description
   * @returns The new version number
   */
  async save(
    config: Record<string, unknown>,
    createdBy: string,
    description?: string,
  ): Promise<number> {
    // Validate against shared config schema
    const result = sharedConfigSchema.safeParse(config);
    if (!result.success) {
      const errors = result.error.issues
        .map((e) => `  - ${e.path.join('.')}: ${e.message}`)
        .join('\n');
      throw new Error(`Shared config validation failed:\n${errors}`);
    }

    let configToStore: Record<string, unknown> = result.data as Record<string, unknown>;
    let encryptedPaths: string[] = [];

    // Encrypt sensitive fields if master key is available
    if (this.masterKey) {
      const encrypted = encryptConfigFields(
        configToStore,
        [...SENSITIVE_FIELD_PATHS],
        this.masterKey,
        this.keyVersion,
      );
      configToStore = encrypted.encrypted;
      encryptedPaths = encrypted.encryptedPaths;
    }

    const row = await this.db
      .insertInto('config_versions')
      .values({
        config: JSON.stringify(configToStore),
        created_by: createdBy,
        description: description ?? null,
        encrypted_paths: encryptedPaths,
        key_version: this.keyVersion,
      })
      .returning('version')
      .executeTakeFirstOrThrow();

    return row.version;
  }

  /**
   * List version history (metadata only, no config bodies).
   * Returns versions in reverse chronological order.
   *
   * @param limit - Maximum number of versions to return (default 50)
   */
  async listHistory(limit: number = 50): Promise<ConfigVersionMeta[]> {
    const rows = await this.db
      .selectFrom('config_versions')
      .select(['version', 'created_at', 'created_by', 'description'])
      .orderBy('version', 'desc')
      .limit(limit)
      .execute();

    return rows.map((row) => ({
      version: row.version,
      createdAt: row.created_at,
      createdBy: row.created_by,
      description: row.description,
    }));
  }

  /**
   * Rollback to a specific version.
   * Reads the target version and creates a new version as a copy.
   *
   * @param targetVersion - Version number to rollback to
   * @param createdBy - Who initiated the rollback
   * @returns The new version number
   * @throws Error if target version doesn't exist
   */
  async rollback(targetVersion: number, createdBy: string): Promise<number> {
    const targetRow = await this.db
      .selectFrom('config_versions')
      .selectAll()
      .where('version', '=', targetVersion)
      .executeTakeFirst();

    if (!targetRow) {
      throw new Error(`Config version ${targetVersion} not found`);
    }

    // Create a new version that's a copy of the target
    // Keep the encrypted fields as-is (no re-encryption needed)
    const row = await this.db
      .insertInto('config_versions')
      .values({
        config: targetRow.config,
        created_by: createdBy,
        description: `Rollback to version ${targetVersion}`,
        encrypted_paths: targetRow.encrypted_paths,
      })
      .returning('version')
      .executeTakeFirstOrThrow();

    return row.version;
  }

  /**
   * Get the current (latest) version number.
   * Returns 0 if no versions exist.
   * Used by cluster heartbeats to broadcast config version.
   */
  async getCurrentVersion(): Promise<number> {
    const row = await this.db
      .selectFrom('config_versions')
      .select('version')
      .orderBy('version', 'desc')
      .limit(1)
      .executeTakeFirst();

    return row?.version ?? 0;
  }

  /**
   * Export the current config with sensitive fields redacted.
   * Returns null if no config versions exist.
   * Used for CLI export and diff operations.
   */
  async exportRedacted(): Promise<Record<string, unknown> | null> {
    const row = await this.db
      .selectFrom('config_versions')
      .selectAll()
      .orderBy('version', 'desc')
      .limit(1)
      .executeTakeFirst();

    if (!row) return null;

    const config = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
    const encryptedPaths = row.encrypted_paths ?? [];

    // If there's a master key, decrypt first then redact
    // (so we redact the right paths even if they weren't encrypted)
    if (this.masterKey && encryptedPaths.length > 0) {
      const decrypted = decryptConfigFields(
        config,
        encryptedPaths,
        this.masterKey,
        row.key_version,
        this.oldMasterKey,
      );
      return redactConfigFields(decrypted, encryptedPaths);
    }

    // No master key or no encrypted paths -- just redact any sensitive paths that exist
    return redactConfigFields(config, encryptedPaths);
  }

  /**
   * Rotate the master-key generation for every row in `config_versions`.
   *
   * Mirrors `PgSecretStore.rotateKey`: opens a transaction, loads every row,
   * decrypts with the current key (falling back to `oldMasterKey` when set),
   * re-encrypts under the current master key at `max(key_version) + 1`, and
   * updates only `config` + `key_version`. Audit columns (`created_at`,
   * `created_by`, `description`, `version`, `encrypted_paths`) are
   * deliberately untouched so the history trail stays immutable and
   * `rollback()` / `getByVersion()` keep their semantics.
   *
   * Historical rows are re-encrypted too — otherwise rollback to an older
   * version would fail once `KICI_SECRET_KEY_OLD` is removed.
   *
   * Rows with no encrypted fields (`encrypted_paths = []`) still have their
   * `key_version` bumped so a fully-rotated table has a single generation,
   * but they don't contribute to the `reEncrypted` counter.
   *
   * @returns The number of rows whose ciphertext was re-sealed.
   */
  async rotateKey(): Promise<{ reEncrypted: number; skipped: number }> {
    if (!this.masterKey) {
      throw new Error('Cannot rotate config store key: no master key configured');
    }

    let reEncrypted = 0;
    let skipped = 0;
    let newKeyVersion = this.keyVersion;

    await this.db.transaction().execute(async (trx) => {
      const rows = await trx.selectFrom('config_versions').selectAll().execute();

      // Determine next generation: max current + 1 (or current + 1 if empty).
      const maxVersion = rows.reduce((max, row) => Math.max(max, row.key_version), 0);
      newKeyVersion = Math.max(this.keyVersion, maxVersion) + 1;

      for (const row of rows) {
        const encryptedPaths = row.encrypted_paths ?? [];

        if (encryptedPaths.length === 0) {
          // Nothing to re-encrypt — just bump the generation stamp so the
          // table ends up on a single key_version.
          await trx
            .updateTable('config_versions')
            .set({ key_version: newKeyVersion })
            .where('id', '=', row.id)
            .execute();
          continue;
        }

        // Historical rows may be undecryptable with today's keys (e.g. a DB
        // carrying rows from before the active KICI_SECRET_KEY was introduced,
        // or a skipped rotation chain). Rotation MUST NOT block on them —
        // they were already unreadable before rotation, and aborting the
        // entire call would leave every *decryptable* row stuck on the old
        // key. Skip, record a warning, continue. The operator sees the
        // `skipped` counter in the HTTP response and audit log entry.
        try {
          const rawConfig = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
          const decrypted = decryptConfigFields(
            rawConfig as Record<string, unknown>,
            encryptedPaths,
            this.masterKey!,
            row.key_version,
            this.oldMasterKey,
          );

          const { encrypted } = encryptConfigFields(
            decrypted,
            encryptedPaths,
            this.masterKey!,
            newKeyVersion,
          );

          await trx
            .updateTable('config_versions')
            .set({
              config: JSON.stringify(encrypted),
              key_version: newKeyVersion,
            })
            .where('id', '=', row.id)
            .execute();

          reEncrypted++;
        } catch (err) {
          skipped++;
          logger.warn('Skipping undecryptable config_versions row during rotation', {
            version: row.version,
            keyVersion: row.key_version,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });

    // Only update in-memory generation on successful commit.
    this.keyVersion = newKeyVersion;

    return { reEncrypted, skipped };
  }

  /**
   * Convert a DB row to a SharedConfig with decryption.
   */
  private rowToConfig(row: ConfigVersionRow): { config: SharedConfig; version: number } {
    const rawConfig = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
    const encryptedPaths = row.encrypted_paths ?? [];

    let config: Record<string, unknown> = rawConfig;

    // Decrypt if master key available and there are encrypted paths
    if (this.masterKey && encryptedPaths.length > 0) {
      config = decryptConfigFields(
        config,
        encryptedPaths,
        this.masterKey,
        row.key_version,
        this.oldMasterKey,
      );
    }

    return {
      config: config as SharedConfig,
      version: row.version,
    };
  }
}
