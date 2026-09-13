/**
 * HashiCorp Vault secret store backend implementing SecretStore.
 *
 * Uses hashi-vault-js for KV v2 operations with AppRole or token
 * authentication. Secrets are fetched every time (no caching) for
 * consistency at dispatch time.
 *
 * Secret path mapping: ${basePath}/${orgId}/${scope} within the KV v2 mount.
 */
import Vault from 'hashi-vault-js';
import type { SecretStore } from '@kici-dev/engine';
import type { Logger } from '@kici-dev/shared';

/**
 * Configuration for the Vault secret store backend.
 */
export interface VaultConfig {
  /** Vault server URL (e.g., 'http://vault:8200'). */
  vaultUrl: string;
  /** Authentication method. */
  authMethod: 'approle' | 'token';
  /** AppRole role ID (required for 'approle' auth). */
  roleId?: string;
  /** AppRole secret ID (required for 'approle' auth). */
  secretId?: string;
  /** Static Vault token (required for 'token' auth). */
  token?: string;
  /** Vault Enterprise namespace. */
  namespace?: string;
  /** KV v2 mount path (default: 'secret'). */
  mountPath?: string;
  /** Base path within mount (e.g., 'kici/secrets'). */
  basePath: string;
}

interface AuthState {
  token: string;
  /** Absolute time (ms) when the token expires. */
  expiresAt: number;
}

/**
 * HashiCorp Vault backend implementing SecretStore.
 *
 * Supports AppRole and token authentication. KV v2 CRUD operations
 * map (orgId, scope) to Vault paths under the configured basePath.
 */
export class VaultSecretStore implements SecretStore {
  private readonly client: Vault;
  private readonly config: VaultConfig;
  private readonly mountPath: string;
  private readonly logger: Logger;
  private authState: AuthState | null = null;

  constructor(config: VaultConfig, logger: Logger) {
    this.config = config;
    this.mountPath = config.mountPath ?? 'secret';
    this.logger = logger;

    const url = new URL(config.vaultUrl);
    // hashi-vault-js expects baseUrl to include /v1 (its default is https://127.0.0.1:8200/v1)
    const baseUrl = config.vaultUrl.replace(/\/+$/, '') + '/v1';
    this.client = new Vault({
      https: url.protocol === 'https:',
      baseUrl,
      namespace: config.namespace,
      timeout: 5000,
    });
  }

  /**
   * Log a Vault API request with structured context.
   * Captures operation, path, status, and optionally error for diagnostics.
   */
  private logVaultRequest(operation: string, path: string, status: number, error?: string): void {
    const entry = {
      operation,
      path,
      mountPath: this.mountPath,
      authMethod: this.config.authMethod,
      status,
      ...(error && { error }),
    };
    if (status >= 400) {
      this.logger.error('Vault request failed', entry);
    } else {
      this.logger.info('Vault request', entry);
    }
  }

  /**
   * Authenticate with Vault and cache the token with TTL tracking.
   */
  private async authenticate(): Promise<string> {
    if (this.config.authMethod === 'token') {
      if (!this.config.token) {
        throw new Error('Vault token auth requires a token');
      }
      this.authState = {
        token: this.config.token,
        expiresAt: Infinity,
      };
      return this.authState.token;
    }

    if (!this.config.roleId || !this.config.secretId) {
      throw new Error('Vault AppRole auth requires roleId and secretId');
    }

    const result = await this.client.loginWithAppRole(this.config.roleId, this.config.secretId);

    const token = (result as Record<string, unknown>).client_token as string;
    const leaseDuration = ((result as Record<string, unknown>).lease_duration as number) || 3600;

    this.authState = {
      token,
      expiresAt: Date.now() + (leaseDuration - 30) * 1000,
    };

    return token;
  }

  private async getToken(): Promise<string> {
    if (this.authState && Date.now() < this.authState.expiresAt) {
      return this.authState.token;
    }
    return this.authenticate();
  }

  private async withRetry<T>(fn: (token: string) => Promise<T>): Promise<T> {
    const token = await this.getToken();
    try {
      return await fn(token);
    } catch (err: unknown) {
      const status = isVaultError(err) ? getVaultStatus(err) : undefined;
      if (status === 403 || status === 400) {
        this.authState = null;
        const newToken = await this.authenticate();
        return fn(newToken);
      }
      throw err;
    }
  }

  /**
   * Build the full Vault path for a scoped secret.
   */
  private secretPath(orgId: string, scope: string): string {
    return `${this.config.basePath}/${orgId}/${scope}`;
  }

  /**
   * Get all secrets for a scope as key-value pairs.
   */
  async getSecrets(orgId: string, scope: string): Promise<Record<string, string>> {
    const path = this.secretPath(orgId, scope);
    return this.withRetry(async (token) => {
      try {
        const result = await this.client.readKVSecret(token, path, undefined, this.mountPath);
        this.logVaultRequest('READ', path, 200);
        const data = (result as Record<string, unknown>)?.data;
        if (data && typeof data === 'object') {
          return data as Record<string, string>;
        }
        return {};
      } catch (err: unknown) {
        const status = isVaultError(err) ? getVaultStatus(err) : undefined;
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logVaultRequest('READ', path, status ?? 0, errMsg);
        if (status === 404) {
          return {};
        }
        throw err;
      }
    });
  }

  /**
   * Set (create or update) a secret in a scope.
   */
  async setSecret(orgId: string, scope: string, key: string, value: string): Promise<void> {
    const path = this.secretPath(orgId, scope);
    await this.withRetry(async (token) => {
      let existing: Record<string, string> = {};
      let version = 0;

      try {
        const result = await this.client.readKVSecret(token, path, undefined, this.mountPath);
        this.logVaultRequest('READ', path, 200);
        const resultObj = result as Record<string, unknown>;
        existing = (resultObj.data as Record<string, string>) ?? {};
        const metadata = resultObj.metadata as Record<string, unknown> | undefined;
        version = (metadata?.version as number) ?? 0;
      } catch (err: unknown) {
        const status = isVaultError(err) ? getVaultStatus(err) : undefined;
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logVaultRequest('READ', path, status ?? 0, errMsg);
        if (status === 404) {
          existing = {};
          version = 0;
        } else {
          throw err;
        }
      }

      const merged = { ...existing, [key]: value };

      try {
        if (version === 0) {
          await this.client.createKVSecret(token, path, merged, this.mountPath);
          this.logVaultRequest('CREATE', path, 200);
        } else {
          await this.client.updateKVSecret(token, path, merged, version, this.mountPath);
          this.logVaultRequest('UPDATE', path, 200);
        }
      } catch (err: unknown) {
        const status = isVaultError(err) ? getVaultStatus(err) : undefined;
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logVaultRequest(version === 0 ? 'CREATE' : 'UPDATE', path, status ?? 0, errMsg);
        throw err;
      }
    });
  }

  /**
   * Delete a secret key from a scope.
   */
  async deleteSecret(orgId: string, scope: string, key: string): Promise<void> {
    const path = this.secretPath(orgId, scope);
    await this.withRetry(async (token) => {
      let existing: Record<string, string>;
      let version: number;

      try {
        const result = await this.client.readKVSecret(token, path, undefined, this.mountPath);
        this.logVaultRequest('READ', path, 200);
        const resultObj = result as Record<string, unknown>;
        existing = (resultObj.data as Record<string, string>) ?? {};
        const metadata = resultObj.metadata as Record<string, unknown> | undefined;
        version = (metadata?.version as number) ?? 0;
      } catch (err: unknown) {
        const status = isVaultError(err) ? getVaultStatus(err) : undefined;
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logVaultRequest('READ', path, status ?? 0, errMsg);
        if (status === 404) {
          return;
        }
        throw err;
      }

      const { [key]: _removed, ...remaining } = existing;

      try {
        if (Object.keys(remaining).length === 0) {
          await this.client.eliminateKVSecret(token, path, this.mountPath);
          this.logVaultRequest('DELETE', path, 200);
        } else {
          await this.client.updateKVSecret(token, path, remaining, version, this.mountPath);
          this.logVaultRequest('UPDATE', path, 200);
        }
      } catch (err: unknown) {
        const status = isVaultError(err) ? getVaultStatus(err) : undefined;
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logVaultRequest(
          Object.keys(remaining).length === 0 ? 'DELETE' : 'UPDATE',
          path,
          status ?? 0,
          errMsg,
        );
        throw err;
      }
    });
  }

  /**
   * List all secret key names in a scope.
   */
  async listKeys(orgId: string, scope: string): Promise<string[]> {
    const secrets = await this.getSecrets(orgId, scope);
    return Object.keys(secrets);
  }

  /**
   * List all distinct scopes for an org.
   * Vault KV v2 LIST only returns immediate children — directories end with '/'.
   * We recurse into directories to discover leaf scopes (paths that hold actual secrets).
   */
  async listScopes(orgId: string): Promise<string[]> {
    return this.withRetry(async (token) => {
      const basePath = orgId ? `${this.config.basePath}/${orgId}` : this.config.basePath;
      const scopes: string[] = [];

      const walk = async (prefix: string): Promise<void> => {
        let keys: string[];
        const listPath = prefix ? `${basePath}/${prefix}` : basePath;
        try {
          const result = await this.client.listKVSecrets(token, listPath, this.mountPath);
          this.logVaultRequest('LIST', listPath, 200);
          const raw = (result as Record<string, unknown>)?.keys;
          keys = Array.isArray(raw) ? (raw as string[]) : [];
        } catch (err: unknown) {
          const status = isVaultError(err) ? getVaultStatus(err) : undefined;
          const errMsg = err instanceof Error ? err.message : String(err);
          if (status === 404 || status === 400) {
            this.logVaultRequest('LIST', listPath, status, errMsg);
            return;
          }
          this.logVaultRequest('LIST', listPath, status ?? 0, errMsg);
          throw err;
        }

        for (const key of keys) {
          const fullKey = prefix ? `${prefix}${key}` : key;
          if (key.endsWith('/')) {
            // Directory — recurse
            await walk(fullKey);
          } else {
            // Leaf secret
            scopes.push(fullKey);
          }
        }
      };

      await walk('');
      return scopes;
    });
  }

  /**
   * Get all secrets for an org (for resolver).
   * Lists scopes then reads each to collect all encrypted/plain values.
   */
  async getAllSecrets(
    orgId: string,
  ): Promise<Array<{ scope: string; key: string; encryptedValue: string; keyVersion: number }>> {
    const scopes = await this.listScopes(orgId);
    const results: Array<{
      scope: string;
      key: string;
      encryptedValue: string;
      keyVersion: number;
    }> = [];

    for (const scope of scopes) {
      const secrets = await this.getSecrets(orgId, scope);
      for (const [key, value] of Object.entries(secrets)) {
        results.push({ scope, key, encryptedValue: value, keyVersion: 1 });
      }
    }

    return results;
  }
}

// -- Vault error helpers --

function isVaultError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'isVaultError' in err &&
    (err as Record<string, unknown>).isVaultError === true
  );
}

function getVaultStatus(err: unknown): number | undefined {
  if (
    err !== null &&
    typeof err === 'object' &&
    'response' in err &&
    typeof (err as Record<string, unknown>).response === 'object'
  ) {
    const response = (err as Record<string, Record<string, unknown>>).response;
    return response?.status as number | undefined;
  }
  return undefined;
}
