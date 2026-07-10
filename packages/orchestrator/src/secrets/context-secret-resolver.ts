/**
 * Shared factory for the dispatch-time `SecretResolver` bound to the orchestrator's
 * DB-backed context/binding/secret stores.
 *
 * Both boot paths use it: `server.ts` (platform/hybrid) always builds it, and
 * `standalone.ts` (independent) builds it only when dispatch-time context-scoped
 * secret resolution is explicitly opted in (the local dev plane). Keeping the
 * ~one construction in one place stops the two call sites from drifting.
 */

import type { Kysely } from 'kysely';
import type { SecretStore } from '@kici-dev/engine';
import type { Logger } from '@kici-dev/shared';
import type { Database } from '../db/types.js';
import { ContextStore } from '../contexts/context-store.js';
import type { AuditLogger } from './audit-logger.js';
import type { PgSecretStore } from './pg-secret-store.js';
import { SecretResolver, type SecretStoreLike } from './secret-resolver.js';

export interface ContextSecretResolverDeps {
  pgSecretStore: PgSecretStore;
  backendStores: Map<string, SecretStore>;
  db: Kysely<Database>;
  auditLogger: AuditLogger;
  logger: Logger;
}

/**
 * Build a `SecretResolver` over the org's contexts, bindings, and registered
 * secret backends. The `pg` backend decrypts through the master key; external
 * backends (Vault) return plaintext, so their decrypt is identity.
 */
export function buildContextSecretResolver(deps: ContextSecretResolverDeps): SecretResolver {
  const { pgSecretStore, backendStores, db, auditLogger, logger } = deps;
  const envStore = new ContextStore(db);

  const resolverBackendStores = new Map<string, SecretStoreLike>();
  for (const [backendName, store] of backendStores) {
    if (backendName === 'pg') {
      // PG backend: getAllSecrets returns encrypted rows; decrypt via master key.
      resolverBackendStores.set('pg', {
        getAllSecrets: async (orgId: string) => {
          const raw = await pgSecretStore.getAllSecrets(orgId);
          return raw.map((r) => ({
            id: '',
            orgId,
            scope: r.scope,
            key: r.key,
            encryptedValue: r.encryptedValue,
            backendType: 'pg' as const,
            keyVersion: r.keyVersion,
            createdAt: '',
            updatedAt: '',
          }));
        },
        decrypt: (secret) =>
          pgSecretStore.decryptValue(
            secret.orgId,
            secret.scope,
            secret.key,
            secret.encryptedValue,
            secret.keyVersion,
          ),
        getSecrets: (orgId, scope) => pgSecretStore.getSecrets(orgId, scope),
      });
    } else {
      // External backends (Vault): values are already plaintext; decrypt is identity.
      resolverBackendStores.set(backendName, {
        getAllSecrets: async (orgId: string) => {
          const raw = await store.getAllSecrets(orgId);
          return raw.map((r) => ({
            id: '',
            orgId,
            scope: r.scope,
            key: r.key,
            encryptedValue: r.encryptedValue,
            backendType: 'vault' as const,
            keyVersion: 1,
            createdAt: '',
            updatedAt: '',
          }));
        },
        decrypt: (secret) => secret.encryptedValue,
        getSecrets: (orgId, scope) => store.getSecrets(orgId, scope),
      });
    }
  }

  return new SecretResolver({
    contextStore: {
      getByName: async (orgId, name) => {
        const row = await envStore.getByName(orgId, name);
        if (!row) return null;
        return { id: row.id, name: row.name, orgId: row.org_id };
      },
    },
    bindingStore: {
      getByContextId: async (contextId: string) => {
        const rows = await db
          .selectFrom('context_bindings')
          .selectAll()
          .where('context_id', '=', contextId)
          .execute();
        return rows.map((r) => ({
          id: r.id,
          orgId: r.org_id,
          contextId: r.context_id,
          scopePattern: r.scope_pattern,
          hostPattern: r.host_pattern,
          createdAt: r.created_at.toISOString(),
        }));
      },
    },
    backendStores: resolverBackendStores,
    auditLogger,
    logger,
  });
}
