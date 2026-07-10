import { describe, it, expect, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { SecretStore } from '@kici-dev/engine';
import { createLogger } from '@kici-dev/shared';
import type { Database } from '../db/types.js';
import type { AuditLogger } from './audit-logger.js';
import type { PgSecretStore } from './pg-secret-store.js';
import { SecretResolver } from './secret-resolver.js';
import { buildContextSecretResolver } from './context-secret-resolver.js';

const logger = createLogger({ prefix: 'test' });

function makeAuditLogger() {
  return { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLogger;
}

describe('buildContextSecretResolver', () => {
  it('returns a SecretResolver wired over the provided stores', () => {
    const pgSecretStore = {
      getAllSecrets: vi.fn().mockResolvedValue([]),
      getSecrets: vi.fn().mockResolvedValue({}),
      decryptValue: vi.fn(),
    } as unknown as PgSecretStore;
    const backendStores = new Map<string, SecretStore>([['pg', pgSecretStore as never]]);

    const resolver = buildContextSecretResolver({
      pgSecretStore,
      backendStores,
      db: {} as Kysely<Database>,
      auditLogger: makeAuditLogger(),
      logger,
    });

    expect(resolver).toBeInstanceOf(SecretResolver);
  });

  it('routes a named pg-backend lookup through pgSecretStore.getSecrets', async () => {
    const pgSecretStore = {
      getAllSecrets: vi.fn().mockResolvedValue([]),
      getSecrets: vi.fn().mockResolvedValue({ DEPLOY_TOKEN: 'resolved-value' }),
      decryptValue: vi.fn(),
    } as unknown as PgSecretStore;
    const backendStores = new Map<string, SecretStore>([['pg', pgSecretStore as never]]);

    const resolver = buildContextSecretResolver({
      pgSecretStore,
      backendStores,
      db: {} as Kysely<Database>,
      auditLogger: makeAuditLogger(),
      logger,
    });

    const value = await resolver.resolveNamed('__default__', 'production', 'DEPLOY_TOKEN', {
      store: 'pg',
    });
    expect(value).toBe('resolved-value');
    expect(pgSecretStore.getSecrets).toHaveBeenCalledWith('__default__', 'production');
  });
});
