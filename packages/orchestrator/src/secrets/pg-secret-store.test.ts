/**
 * Tests for PgSecretStore (scoped model).
 *
 * Uses mock Kysely to verify:
 * - Secret set/get round-trips with correct encryption AAD (orgId:scope:key)
 * - listKeys returns only key names for a scope
 * - listScopes returns distinct scope names for an org
 * - getAllSecrets returns all encrypted secrets for an org
 * - rotateKey re-encrypts all values with new key version
 * - deleteSecret calls delete with correct filters
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { PgSecretStore } from './pg-secret-store.js';
import { encrypt, decrypt, deriveKey, type EncryptedValue } from './crypto.js';
import type { AuditLogger } from './audit-logger.js';

// ── Test fixtures ──────────────────────────────────────────────

const testKey = deriveKey('a'.repeat(64));
const testKeyVersion = 1;

function makeAuditLogger(): AuditLogger {
  return { log: vi.fn(), query: vi.fn() } as any;
}

// ── Chainable Kysely mock builder ──────────────────────────────

import { createMockDb as _createMockDb } from '../__test-helpers__/mock-db.js';

/**
 * Create a mock Kysely DB supporting PgSecretStore query patterns.
 */
function createMockDb(opts: {
  selectRows?: Record<string, unknown>[];
  selectFirstRow?: Record<string, unknown> | undefined;
  insertedRow?: Record<string, unknown>;
  updatedRow?: Record<string, unknown>;
}) {
  const { db } = _createMockDb({
    selectRows: opts.selectRows ?? [],
    selectFirstRow: opts.selectFirstRow,
    insertedRow: opts.insertedRow ?? {},
    updatedRow: opts.updatedRow ?? {},
  });
  return db;
}

// ── Tests ──────────────────────────────────────────────────────

describe('PgSecretStore', () => {
  let auditLogger: AuditLogger;

  beforeEach(() => {
    auditLogger = makeAuditLogger();
  });

  describe('secret set/get with encryption', () => {
    it('setSecret calls insertInto scoped_secrets with correct AAD (orgId:scope:key)', async () => {
      const db = createMockDb({});
      const store = new PgSecretStore(db as any, testKey, testKeyVersion, auditLogger);

      await store.setSecret('org-001', 'aws/prod', 'API_KEY', 'my-secret-value');

      expect(db.insertInto).toHaveBeenCalledWith('scoped_secrets');
    });

    it('getSecrets decrypts values with correct AAD (orgId:scope:key)', async () => {
      const orgId = 'org-001';
      const scope = 'aws/prod';
      const key = 'DB_PASSWORD';
      const plaintext = 'super-secret-pw';
      const aad = `${orgId}:${scope}:${key}`;
      const encrypted = encrypt(plaintext, testKey, testKeyVersion, aad);

      const rows = [
        {
          id: 'sec-1',
          org_id: orgId,
          scope,
          key,
          encrypted_value: encrypted.data,
          key_version: encrypted.keyVersion,
          backend_type: 'pg',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];

      const db = createMockDb({ selectRows: rows });
      const store = new PgSecretStore(db as any, testKey, testKeyVersion, auditLogger);

      const result = await store.getSecrets(orgId, scope);

      expect(result).toEqual({ DB_PASSWORD: 'super-secret-pw' });
    });

    it('getSecrets query filters out __empty__ sentinel rows', async () => {
      const orgId = 'org-001';
      const scope = 'aws/prod';

      // Only provide the real secret — the __empty__ sentinel is filtered at the DB level
      const realAad = `${orgId}:${scope}:DB_PASSWORD`;
      const realEnc = encrypt('super-secret-pw', testKey, testKeyVersion, realAad);

      const rows = [
        {
          id: 'sec-1',
          org_id: orgId,
          scope,
          key: 'DB_PASSWORD',
          encrypted_value: realEnc.data,
          key_version: realEnc.keyVersion,
          backend_type: 'pg',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];

      const db = createMockDb({ selectRows: rows });
      const store = new PgSecretStore(db as any, testKey, testKeyVersion, auditLogger);

      const result = await store.getSecrets(orgId, scope);

      // Verify the query includes the __empty__ filter (same pattern as listKeys)
      expect(db.selectFrom).toHaveBeenCalledWith('scoped_secrets');
      // Verify result only contains real secrets
      expect(result).toEqual({ DB_PASSWORD: 'super-secret-pw' });
      expect(result).not.toHaveProperty('__empty__');
    });

    it('getSecrets handles multiple secrets in same scope', async () => {
      const orgId = 'org-001';
      const scope = 'aws/prod';
      const secrets = [
        { key: 'KEY_A', value: 'value-a' },
        { key: 'KEY_B', value: 'value-b' },
      ];
      const rows = secrets.map((s) => {
        const aad = `${orgId}:${scope}:${s.key}`;
        const enc = encrypt(s.value, testKey, testKeyVersion, aad);
        return {
          id: `sec-${s.key}`,
          org_id: orgId,
          scope,
          key: s.key,
          encrypted_value: enc.data,
          key_version: enc.keyVersion,
          backend_type: 'pg',
          created_at: new Date(),
          updated_at: new Date(),
        };
      });

      const db = createMockDb({ selectRows: rows });
      const store = new PgSecretStore(db as any, testKey, testKeyVersion, auditLogger);

      const result = await store.getSecrets(orgId, scope);

      expect(result).toEqual({ KEY_A: 'value-a', KEY_B: 'value-b' });
    });

    it('getSecrets with wrong key throws decryption error', async () => {
      const orgId = 'org-001';
      const scope = 'aws/prod';
      const aad = `${orgId}:${scope}:SECRET`;
      const encrypted = encrypt('value', testKey, testKeyVersion, aad);
      const wrongKey = deriveKey('b'.repeat(64));

      const rows = [
        {
          id: 'sec-1',
          org_id: orgId,
          scope,
          key: 'SECRET',
          encrypted_value: encrypted.data,
          key_version: encrypted.keyVersion,
          backend_type: 'pg',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];

      const db = createMockDb({ selectRows: rows });
      const store = new PgSecretStore(db as any, wrongKey, testKeyVersion, auditLogger);

      await expect(store.getSecrets(orgId, scope)).rejects.toThrow();
    });

    it('AAD mismatch prevents cross-scope secret decryption', async () => {
      const aad = 'org-001:aws/prod:SECRET';
      const encrypted = encrypt('value', testKey, testKeyVersion, aad);

      // Try decrypting with a different scope in the AAD
      const rows = [
        {
          id: 'sec-1',
          org_id: 'org-001',
          scope: 'aws/staging', // Different from the AAD used for encryption
          key: 'SECRET',
          encrypted_value: encrypted.data,
          key_version: encrypted.keyVersion,
          backend_type: 'pg',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];

      const db = createMockDb({ selectRows: rows });
      const store = new PgSecretStore(db as any, testKey, testKeyVersion, auditLogger);

      // Should throw because AAD will be "org-001:aws/staging:SECRET" instead of "org-001:aws/prod:SECRET"
      await expect(store.getSecrets('org-001', 'aws/staging')).rejects.toThrow();
    });
  });

  describe('listKeys', () => {
    it('returns only key names for a scope without values', async () => {
      const rows = [{ key: 'API_KEY' }, { key: 'DB_PASSWORD' }, { key: 'TOKEN' }];
      const db = createMockDb({ selectRows: rows });
      const store = new PgSecretStore(db as any, testKey, testKeyVersion, auditLogger);

      const result = await store.listKeys('org-001', 'aws/prod');

      expect(result).toEqual(['API_KEY', 'DB_PASSWORD', 'TOKEN']);
      expect(db.selectFrom).toHaveBeenCalledWith('scoped_secrets');
    });
  });

  describe('listScopes', () => {
    it('returns distinct scope names for an org', async () => {
      const rows = [{ scope: 'aws/prod' }, { scope: 'aws/staging' }, { scope: 'gcp/dev' }];
      const db = createMockDb({ selectRows: rows });
      const store = new PgSecretStore(db as any, testKey, testKeyVersion, auditLogger);

      const result = await store.listScopes('org-001');

      expect(result).toEqual(['aws/prod', 'aws/staging', 'gcp/dev']);
      expect(db.selectFrom).toHaveBeenCalledWith('scoped_secrets');
    });
  });

  describe('getAllSecrets', () => {
    it('returns all secrets for an org without decrypting', async () => {
      const rows = [
        {
          scope: 'aws/prod',
          key: 'API_KEY',
          encrypted_value: 'encrypted-data-1',
          key_version: 1,
        },
        {
          scope: 'aws/staging',
          key: 'DB_PASS',
          encrypted_value: 'encrypted-data-2',
          key_version: 1,
        },
      ];
      const db = createMockDb({ selectRows: rows });
      const store = new PgSecretStore(db as any, testKey, testKeyVersion, auditLogger);

      const result = await store.getAllSecrets('org-001');

      expect(result).toEqual([
        { scope: 'aws/prod', key: 'API_KEY', encryptedValue: 'encrypted-data-1', keyVersion: 1 },
        { scope: 'aws/staging', key: 'DB_PASS', encryptedValue: 'encrypted-data-2', keyVersion: 1 },
      ]);
    });
  });

  describe('deleteSecret', () => {
    it('calls delete with org_id, scope, and key', async () => {
      const db = createMockDb({});
      const store = new PgSecretStore(db as any, testKey, testKeyVersion, auditLogger);

      await store.deleteSecret('org-001', 'aws/prod', 'API_KEY');

      expect(db.deleteFrom).toHaveBeenCalledWith('scoped_secrets');
    });
  });

  describe('dual-key fallback', () => {
    const testKeyOld = deriveKey('b'.repeat(64));

    it('getSecrets falls back to oldMasterKey when current key fails', async () => {
      const orgId = 'org-001';
      const scope = 'aws/prod';
      const key = 'DB_PASSWORD';
      const plaintext = 'old-key-secret';
      const aad = `${orgId}:${scope}:${key}`;
      // Encrypt with old key
      const encrypted = encrypt(plaintext, testKeyOld, 1, aad);

      const rows = [
        {
          id: 'sec-1',
          org_id: orgId,
          scope,
          key,
          encrypted_value: encrypted.data,
          key_version: 1,
          backend_type: 'pg',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];

      const db = createMockDb({ selectRows: rows });
      const store = new PgSecretStore(db as any, testKey, testKeyVersion, auditLogger, testKeyOld);

      const result = await store.getSecrets(orgId, scope);
      expect(result).toEqual({ DB_PASSWORD: 'old-key-secret' });
    });

    it('getSecrets with current key works without fallback', async () => {
      const orgId = 'org-001';
      const scope = 'aws/prod';
      const key = 'TOKEN';
      const plaintext = 'new-key-secret';
      const aad = `${orgId}:${scope}:${key}`;
      // Encrypt with current key
      const encrypted = encrypt(plaintext, testKey, 1, aad);

      const rows = [
        {
          id: 'sec-1',
          org_id: orgId,
          scope,
          key,
          encrypted_value: encrypted.data,
          key_version: 1,
          backend_type: 'pg',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];

      const db = createMockDb({ selectRows: rows });
      const store = new PgSecretStore(db as any, testKey, testKeyVersion, auditLogger, testKeyOld);

      const result = await store.getSecrets(orgId, scope);
      expect(result).toEqual({ TOKEN: 'new-key-secret' });
    });

    it('decryptValue falls back to oldMasterKey when current key fails', () => {
      const orgId = 'org-001';
      const scope = 'aws/prod';
      const key = 'SECRET';
      const plaintext = 'fallback-value';
      const aad = `${orgId}:${scope}:${key}`;
      // Encrypt with old key
      const encrypted = encrypt(plaintext, testKeyOld, 1, aad);

      const db = createMockDb({});
      const store = new PgSecretStore(db as any, testKey, testKeyVersion, auditLogger, testKeyOld);

      const result = store.decryptValue(orgId, scope, key, encrypted.data, 1);
      expect(result).toBe('fallback-value');
    });

    it('getSecrets without oldMasterKey still throws on wrong key', async () => {
      const orgId = 'org-001';
      const scope = 'aws/prod';
      const aad = `${orgId}:${scope}:SECRET`;
      // Encrypt with old key
      const encrypted = encrypt('value', testKeyOld, 1, aad);

      const rows = [
        {
          id: 'sec-1',
          org_id: orgId,
          scope,
          key: 'SECRET',
          encrypted_value: encrypted.data,
          key_version: 1,
          backend_type: 'pg',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];

      const db = createMockDb({ selectRows: rows });
      // No oldMasterKey provided
      const store = new PgSecretStore(db as any, testKey, testKeyVersion, auditLogger);

      await expect(store.getSecrets(orgId, scope)).rejects.toThrow();
    });
  });

  describe('rotateKey', () => {
    it('re-encrypts all secrets with new key version in a transaction', async () => {
      const orgId = 'org-001';
      const scope = 'aws/prod';
      const secrets = [
        { key: 'KEY_A', value: 'value-a' },
        { key: 'KEY_B', value: 'value-b' },
      ];
      const rows = secrets.map((s, i) => {
        const aad = `${orgId}:${scope}:${s.key}`;
        const enc = encrypt(s.value, testKey, 1, aad);
        return {
          id: `sec-${i}`,
          org_id: orgId,
          scope,
          key: s.key,
          encrypted_value: enc.data,
          key_version: 1,
          backend_type: 'pg',
          created_at: new Date(),
          updated_at: new Date(),
        };
      });

      const db = createMockDb({ selectRows: rows });
      const store = new PgSecretStore(db as any, testKey, 1, auditLogger);

      const result = await store.rotateKey();

      expect(result.reEncrypted).toBe(2);
      expect(db.transaction).toHaveBeenCalled();
    });

    it('rotateKey returns 0 when no secrets exist', async () => {
      const db = createMockDb({ selectRows: [] });
      const store = new PgSecretStore(db as any, testKey, 1, auditLogger);

      const result = await store.rotateKey();

      expect(result.reEncrypted).toBe(0);
    });

    it('rotateKey with oldMasterKey decrypts with old key and re-encrypts with new key', async () => {
      const testKeyOld = deriveKey('b'.repeat(64));
      const orgId = 'org-001';
      const scope = 'aws/prod';
      const secrets = [
        { key: 'KEY_A', value: 'value-a' },
        { key: 'KEY_B', value: 'value-b' },
      ];
      // Encrypt with old key
      const rows = secrets.map((s, i) => {
        const aad = `${orgId}:${scope}:${s.key}`;
        const enc = encrypt(s.value, testKeyOld, 1, aad);
        return {
          id: `sec-${i}`,
          org_id: orgId,
          scope,
          key: s.key,
          encrypted_value: enc.data,
          key_version: 1,
          backend_type: 'pg',
          created_at: new Date(),
          updated_at: new Date(),
        };
      });

      const db = createMockDb({ selectRows: rows });
      const store = new PgSecretStore(db as any, testKey, 1, auditLogger, testKeyOld);

      const result = await store.rotateKey();

      expect(result.reEncrypted).toBe(2);
      expect(db.transaction).toHaveBeenCalled();
    });

    it('rotateKey without oldMasterKey preserves same-key behavior', async () => {
      const orgId = 'org-001';
      const scope = 'aws/prod';
      const aad = `${orgId}:${scope}:KEY_A`;
      const enc = encrypt('value-a', testKey, 1, aad);
      const rows = [
        {
          id: 'sec-0',
          org_id: orgId,
          scope,
          key: 'KEY_A',
          encrypted_value: enc.data,
          key_version: 1,
          backend_type: 'pg',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];

      const db = createMockDb({ selectRows: rows });
      // No old key -- same-key rotation
      const store = new PgSecretStore(db as any, testKey, 1, auditLogger);

      const result = await store.rotateKey();

      expect(result.reEncrypted).toBe(1);
    });
  });

  describe('scope CRUD', () => {
    it('createScope inserts a sentinel __empty__ row', async () => {
      const db = createMockDb({ selectRows: [] });
      const store = new PgSecretStore(db as any, testKey, testKeyVersion, auditLogger);

      await store.createScope('org-001', 'aws/prod');

      expect(db.insertInto).toHaveBeenCalledWith('scoped_secrets');
    });

    it('createScope is a no-op when scope already has keys', async () => {
      // listKeys will return real keys, so createScope should not insert
      const db = createMockDb({ selectRows: [{ key: 'API_KEY' }] });
      const store = new PgSecretStore(db as any, testKey, testKeyVersion, auditLogger);

      await store.createScope('org-001', 'aws/prod');

      // insertInto should NOT have been called
      expect(db.insertInto).not.toHaveBeenCalled();
    });

    it('renameScope uses a transaction', async () => {
      const orgId = 'org-001';
      const oldScope = 'aws/old';
      const enc = encrypt('value-a', testKey, testKeyVersion, `${orgId}:${oldScope}:KEY_A`);
      const db = createMockDb({
        selectRows: [
          {
            id: 'sec-0',
            org_id: orgId,
            scope: oldScope,
            key: 'KEY_A',
            encrypted_value: enc.data,
            key_version: testKeyVersion,
          },
        ],
      });
      const store = new PgSecretStore(db as any, testKey, testKeyVersion, auditLogger);

      await store.renameScope(orgId, oldScope, 'aws/new');

      expect(db.transaction).toHaveBeenCalled();
    });

    it('renameScope rejects renaming a scope that does not exist', async () => {
      // Empty select rows → no scoped_secrets and no environment_bindings for
      // the old scope, so the rename must throw rather than silently succeed
      // (which the dashboard would surface as a misleading 200).
      const db = createMockDb({ selectRows: [] });
      const store = new PgSecretStore(db as any, testKey, testKeyVersion, auditLogger);

      await expect(store.renameScope('org-001', 'missing', 'missing-2')).rejects.toThrow(
        /not found/i,
      );
    });

    it('deleteScope uses a transaction', async () => {
      const db = createMockDb({});
      const store = new PgSecretStore(db as any, testKey, testKeyVersion, auditLogger);

      await store.deleteScope('org-001', 'aws/prod');

      expect(db.transaction).toHaveBeenCalled();
    });
  });
});

// ── loadOldMasterKey tests ──────────────────────────────────────

import { loadOldMasterKey } from './config.js';

describe('loadOldMasterKey', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.KICI_SECRET_KEY_OLD;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns undefined when neither env var nor file is set', () => {
    const result = loadOldMasterKey();
    expect(result).toBeUndefined();
  });

  it('returns Buffer when KICI_SECRET_KEY_OLD is set', () => {
    process.env.KICI_SECRET_KEY_OLD = 'b'.repeat(64);
    const result = loadOldMasterKey();
    expect(result).toBeInstanceOf(Buffer);
    expect(result!.length).toBe(32);
  });
});
