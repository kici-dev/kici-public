/**
 * PostgreSQL-backed secret store implementing SecretStore.
 *
 * Encrypts secret values at rest using AES-256-GCM with AAD binding
 * (orgId:scope:keyName) to prevent cross-scope secret swaps.
 *
 * Operates on the scoped_secrets table with (org_id, scope, key) composite key.
 */
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { SecretStore } from '@kici-dev/engine';
import { encrypt, decrypt, type EncryptedValue } from '@kici-dev/shared';
import type { AuditLogger } from './audit-logger.js';

/**
 * Thrown by `renameScope` when the named scope has no secret rows and no
 * environment binding — i.e. there is nothing to rename. Consumers map this to
 * a 404 (admin HTTP route) or a structured not-found response (dashboard path).
 */
export class SecretScopeNotFoundError extends Error {
  constructor(public readonly scope: string) {
    super(`Secret scope '${scope}' not found`);
    this.name = 'SecretScopeNotFoundError';
  }
}

/**
 * PostgreSQL secret store with AES-256-GCM encryption.
 * Uses scoped_secrets table keyed by (org_id, scope, key).
 */
export class PgSecretStore implements SecretStore {
  /**
   * When false, setSecret() rejects for non-internal scopes (customer secrets disabled).
   * Internal scopes (__source__/* and __webhook__/*) are always allowed.
   */
  customerSecretsEnabled = true;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly masterKey: Buffer,
    private keyVersion: number,
    private readonly auditLogger: AuditLogger,
    private readonly oldMasterKey?: Buffer,
  ) {}

  /**
   * Create a PgSecretStore with keyVersion initialized from the database.
   * Reads MAX(key_version) from scoped_secrets to avoid version conflicts
   * after orchestrator restarts.
   */
  static async create(
    db: Kysely<Database>,
    masterKey: Buffer,
    auditLogger: AuditLogger,
    oldMasterKey?: Buffer,
  ): Promise<PgSecretStore> {
    const result = await db
      .selectFrom('scoped_secrets')
      .select(sql<number>`COALESCE(MAX(key_version), 0)`.as('max_version'))
      .executeTakeFirst();
    const keyVersion = (result?.max_version ?? 0) + 1;
    return new PgSecretStore(db, masterKey, keyVersion, auditLogger, oldMasterKey);
  }

  /**
   * Decrypt with current key, falling back to old key if available.
   * Follows the same dual-key pattern as decryptPrivateKey() in ephemeral-keys.ts.
   */
  private decryptWithFallback(encrypted: EncryptedValue, aad: string): string {
    // Try current key first
    try {
      return decrypt(encrypted, this.masterKey, aad);
    } catch {
      // If no old key, re-throw
      if (!this.oldMasterKey) {
        throw new Error(`Failed to decrypt secret with current key (AAD: ${aad})`);
      }
    }

    // Fall back to old key
    try {
      return decrypt(encrypted, this.oldMasterKey, aad);
    } catch {
      throw new Error(`Failed to decrypt secret with both current and old key (AAD: ${aad})`);
    }
  }

  /**
   * Get all secrets for a scope as decrypted key-value pairs.
   */
  async getSecrets(orgId: string, scope: string): Promise<Record<string, string>> {
    const rows = await this.db
      .selectFrom('scoped_secrets')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('scope', '=', scope)
      .where('key', '!=', '__empty__')
      .execute();

    const result: Record<string, string> = {};
    for (const row of rows) {
      const aad = `${orgId}:${scope}:${row.key}`;
      const encrypted: EncryptedValue = {
        data: row.encrypted_value,
        keyVersion: row.key_version,
      };
      result[row.key] = this.decryptWithFallback(encrypted, aad);
    }
    return result;
  }

  /**
   * Set (create or update) a secret in a scope.
   * Encrypts the value with AAD = "orgId:scope:key".
   */
  /** Check if a scope is internal/operational (always allowed regardless of toggle). */
  private isInternalScope(scope: string): boolean {
    // Strip backend prefix if present (e.g., 'pg:__source__/...')
    const colonIdx = scope.indexOf(':');
    const path = colonIdx >= 0 ? scope.slice(colonIdx + 1) : scope;
    return path.startsWith('__source__/') || path.startsWith('__webhook__/');
  }

  async setSecret(orgId: string, scope: string, key: string, value: string): Promise<void> {
    if (!this.customerSecretsEnabled && !this.isInternalScope(scope)) {
      throw new Error(
        'PG customer secrets are disabled. Use an external secret backend or enable pgCustomerSecrets in config.',
      );
    }

    const aad = `${orgId}:${scope}:${key}`;
    const encrypted = encrypt(value, this.masterKey, this.keyVersion, aad);

    await this.db
      .insertInto('scoped_secrets')
      .values({
        org_id: orgId,
        scope,
        key,
        encrypted_value: encrypted.data,
        key_version: encrypted.keyVersion,
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'scope', 'key']).doUpdateSet({
          encrypted_value: encrypted.data,
          key_version: encrypted.keyVersion,
          updated_at: sql`now()`,
        }),
      )
      .execute();
  }

  /**
   * Delete a secret from a scope.
   */
  async deleteSecret(orgId: string, scope: string, key: string): Promise<void> {
    await this.db
      .deleteFrom('scoped_secrets')
      .where('org_id', '=', orgId)
      .where('scope', '=', scope)
      .where('key', '=', key)
      .execute();
  }

  /**
   * List all secret key names in a scope (no values returned).
   */
  async listKeys(orgId: string, scope: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('scoped_secrets')
      .select('key')
      .where('org_id', '=', orgId)
      .where('scope', '=', scope)
      .where('key', '!=', '__empty__')
      .orderBy('key', 'asc')
      .execute();

    return rows.map((r) => r.key);
  }

  /**
   * List all distinct scopes for an org.
   *
   * When orgId is empty, returns all distinct org_ids (with trailing slash)
   * to support backend-sync scope discovery. This matches the Vault convention
   * where listScopes('') returns top-level directory entries.
   */
  async listScopes(orgId: string): Promise<string[]> {
    // Empty orgId: return all distinct org_ids for backend-sync discovery
    if (orgId === '') {
      const rows = await this.db
        .selectFrom('scoped_secrets')
        .select('org_id')
        .distinct()
        .orderBy('org_id', 'asc')
        .execute();

      return rows.map((r) => `${r.org_id}/`);
    }

    const rows = await this.db
      .selectFrom('scoped_secrets')
      .select('scope')
      .distinct()
      .where('org_id', '=', orgId)
      .orderBy('scope', 'asc')
      .execute();

    const scopes = rows.map((r) => r.scope);

    // When customer secrets are disabled, only show internal scopes for dashboard
    if (!this.customerSecretsEnabled) {
      return scopes.filter((s) => this.isInternalScope(s));
    }

    return scopes;
  }

  /**
   * Get all secrets for an org (for resolver).
   * Returns scope, key, encrypted value, and key version without decrypting.
   */
  async getAllSecrets(
    orgId: string,
  ): Promise<Array<{ scope: string; key: string; encryptedValue: string; keyVersion: number }>> {
    const rows = await this.db
      .selectFrom('scoped_secrets')
      .select(['scope', 'key', 'encrypted_value', 'key_version'])
      .where('org_id', '=', orgId)
      .where('key', '!=', '__empty__')
      .execute();

    return rows.map((r) => ({
      scope: r.scope,
      key: r.key,
      encryptedValue: r.encrypted_value,
      keyVersion: r.key_version,
    }));
  }

  /**
   * Decrypt a single secret value given its encrypted data, key version, and AAD components.
   */
  decryptValue(
    orgId: string,
    scope: string,
    key: string,
    encryptedValue: string,
    keyVersion: number,
  ): string {
    const aad = `${orgId}:${scope}:${key}`;
    return this.decryptWithFallback({ data: encryptedValue, keyVersion }, aad);
  }

  // ── Scope CRUD ──────────────────────────────────────────────────

  /**
   * Create an empty scope using a sentinel row (__empty__ key).
   * If the scope already has keys, this is a no-op (idempotent).
   */
  async createScope(orgId: string, scope: string): Promise<void> {
    const existing = await this.listKeys(orgId, scope);
    if (existing.length > 0) return; // Scope already exists with real keys

    // Check if sentinel already exists
    const sentinel = await this.db
      .selectFrom('scoped_secrets')
      .select('id')
      .where('org_id', '=', orgId)
      .where('scope', '=', scope)
      .where('key', '=', '__empty__')
      .executeTakeFirst();
    if (sentinel) return;

    const aad = `${orgId}:${scope}:__empty__`;
    const encrypted = encrypt('', this.masterKey, this.keyVersion, aad);
    await this.db
      .insertInto('scoped_secrets')
      .values({
        org_id: orgId,
        scope,
        key: '__empty__',
        encrypted_value: encrypted.data,
        key_version: encrypted.keyVersion,
      })
      .execute();
  }

  /**
   * Rename a scope -- atomically update scoped_secrets and environment_bindings.
   */
  async renameScope(orgId: string, oldScope: string, newScope: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      // Fetch all secret rows for this scope — need to re-encrypt with new AAD
      // because AAD includes scope name (orgId:scope:key).
      const rows = await trx
        .selectFrom('scoped_secrets')
        .selectAll()
        .where('org_id', '=', orgId)
        .where('scope', '=', oldScope)
        .execute();

      // A scope exists when it has at least one secret row (empty scopes carry
      // an `__empty__` sentinel) or an environment binding references it.
      // Renaming a scope that exists in neither would silently commit zero
      // changes and report success — reject it so the caller gets a 4xx
      // instead of a misleading 200.
      const bindings = await trx
        .selectFrom('environment_bindings')
        .select('id')
        .where('org_id', '=', orgId)
        .where('scope_pattern', '=', oldScope)
        .execute();
      if (rows.length === 0 && bindings.length === 0) {
        throw new SecretScopeNotFoundError(oldScope);
      }

      for (const row of rows) {
        const oldAad = `${orgId}:${oldScope}:${row.key}`;
        const newAad = `${orgId}:${newScope}:${row.key}`;
        const encrypted: EncryptedValue = {
          data: row.encrypted_value,
          keyVersion: row.key_version,
        };
        const plaintext = this.decryptWithFallback(encrypted, oldAad);
        const reEncrypted = encrypt(plaintext, this.masterKey, row.key_version, newAad);

        await trx
          .updateTable('scoped_secrets')
          .set({
            scope: newScope,
            encrypted_value: reEncrypted.data,
            updated_at: sql`now()`,
          })
          .where('id', '=', row.id)
          .execute();
      }

      // Update environment bindings referencing the old scope
      await trx
        .updateTable('environment_bindings')
        .set({ scope_pattern: newScope })
        .where('org_id', '=', orgId)
        .where('scope_pattern', '=', oldScope)
        .execute();
    });
  }

  /**
   * Delete a scope and all its secrets, plus any environment bindings referencing it.
   */
  async deleteScope(orgId: string, scope: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom('scoped_secrets')
        .where('org_id', '=', orgId)
        .where('scope', '=', scope)
        .execute();
      await trx
        .deleteFrom('environment_bindings')
        .where('org_id', '=', orgId)
        .where('scope_pattern', '=', scope)
        .execute();
    });
  }

  // ── Key rotation ─────────────────────────────────────────────────

  /**
   * Rotate the encryption key version.
   * Re-encrypts all secrets with the same master key but a new key version.
   * Runs in a transaction for atomicity.
   *
   * @returns Number of re-encrypted secret values.
   */
  async rotateKey(): Promise<{ reEncrypted: number }> {
    let reEncrypted = 0;

    await this.db.transaction().execute(async (trx) => {
      const rows = await trx.selectFrom('scoped_secrets').selectAll().execute();

      // Determine next version: max current + 1 (or 2 if no secrets)
      const maxVersion = rows.reduce((max, row) => Math.max(max, row.key_version), 0);
      const newKeyVersion = maxVersion + 1;

      for (const row of rows) {
        const aad = `${row.org_id}:${row.scope}:${row.key}`;
        const encrypted: EncryptedValue = {
          data: row.encrypted_value,
          keyVersion: row.key_version,
        };
        // Decrypt using fallback (tries current key first, then old key)
        const plaintext = this.decryptWithFallback(encrypted, aad);

        // Re-encrypt with current (new) key at new version
        const reEncryptedValue = encrypt(plaintext, this.masterKey, newKeyVersion, aad);

        await trx
          .updateTable('scoped_secrets')
          .set({
            encrypted_value: reEncryptedValue.data,
            key_version: newKeyVersion,
            updated_at: sql`now()`,
          })
          .where('id', '=', row.id)
          .execute();

        reEncrypted++;
      }

      this.keyVersion = newKeyVersion;
    });

    return { reEncrypted };
  }
}
