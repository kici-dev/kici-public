/**
 * Tests for SharedConfigStore.
 *
 * Uses mock Kysely DB to verify CRUD operations:
 * - save creates new version with validation
 * - getLatest returns most recent version (decrypted)
 * - getByVersion returns specific version
 * - rollback creates copy with incremented version
 * - listHistory returns metadata only
 * - exportRedacted masks sensitive values
 * - encryption round-trip for sensitive fields
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { SharedConfigStore } from './shared-store.js';
import { encrypt } from '@kici-dev/shared';
import { encryptConfigFields } from './encryption.js';
import { SENSITIVE_FIELD_PATHS } from './loader.js';

// ── Test data ───────────────────────────────────────────────────

const TEST_MASTER_KEY = randomBytes(32);

function makeSharedConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    platform: {
      url: 'wss://platform.kici.dev/ws',
      token: 'platform-token-secret',
    },
    secrets: {
      key: 'test-master-key-value',
      bootstrapAdminToken: 'bootstrap-token-secret',
    },
    agentAuth: 'token',
    ...overrides,
  };
}

function makeDbRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'uuid-1',
    version: 1,
    config: JSON.stringify(makeSharedConfig()),
    created_at: new Date('2026-02-22T10:00:00Z'),
    created_by: 'cli:seed',
    description: 'Initial config',
    encrypted_paths: [],
    key_version: 1,
    ...overrides,
  };
}

// ── Mock DB builder ─────────────────────────────────────────────

import { createMockDb as _createMockDb } from '../__test-helpers__/mock-db.js';

/**
 * Create a mock Kysely DB for SharedConfigStore tests.
 * Returns { db, mocks } with backward-compatible mock references.
 */
function createMockDb(
  options: {
    selectRows?: Record<string, unknown>[];
    selectFirstRow?: Record<string, unknown> | undefined;
    insertReturning?: Record<string, unknown>;
  } = {},
) {
  const { db, mocks } = _createMockDb({
    selectRows: options.selectRows ?? [],
    selectFirstRow: options.selectFirstRow,
    insertReturning: options.insertReturning ?? { version: 1 },
  });

  return {
    db,
    mocks: {
      execute: mocks.selectExecute,
      executeTakeFirst: mocks.selectExecuteTakeFirst,
      executeTakeFirstOrThrow: mocks.insertExecuteTakeFirstOrThrow,
      values: mocks.insertValues,
      where: mocks.selectWhere,
      selectAll: mocks.selectAll,
      select: mocks.select,
      orderBy: mocks.selectOrderBy,
      limit: mocks.selectLimit,
      returning: mocks.insertReturning,
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe('SharedConfigStore', () => {
  describe('getLatest', () => {
    it('returns null when no versions exist', async () => {
      const { db } = createMockDb({ selectFirstRow: undefined });
      const store = new SharedConfigStore(db, null);

      const result = await store.getLatest();
      expect(result).toBeNull();
    });

    it('returns the latest version with config', async () => {
      const row = makeDbRow({ version: 3 });
      const { db } = createMockDb({ selectFirstRow: row });
      const store = new SharedConfigStore(db, null);

      const result = await store.getLatest();
      expect(result).not.toBeNull();
      expect(result!.version).toBe(3);
      expect(result!.config.platform?.token).toBe('platform-token-secret');
    });

    it('decrypts sensitive fields when master key is available', async () => {
      // Encrypt the config first
      const plainConfig = makeSharedConfig();
      const { encrypted, encryptedPaths } = encryptConfigFields(
        plainConfig,
        [...SENSITIVE_FIELD_PATHS],
        TEST_MASTER_KEY,
        1,
      );

      const row = makeDbRow({
        version: 1,
        config: JSON.stringify(encrypted),
        encrypted_paths: encryptedPaths,
      });

      const { db } = createMockDb({ selectFirstRow: row });
      const store = new SharedConfigStore(db, TEST_MASTER_KEY);

      const result = await store.getLatest();
      expect(result).not.toBeNull();
      // Should be decrypted back to plaintext
      expect(result!.config.platform?.token).toBe('platform-token-secret');
      expect(result!.config.secrets?.key).toBe('test-master-key-value');
      expect(result!.config.secrets?.bootstrapAdminToken).toBe('bootstrap-token-secret');
    });

    it('queries config_versions table ordered by version DESC', async () => {
      const { db, mocks } = createMockDb({ selectFirstRow: undefined });
      const store = new SharedConfigStore(db, null);

      await store.getLatest();

      expect(db.selectFrom).toHaveBeenCalledWith('config_versions');
      expect(mocks.orderBy).toHaveBeenCalledWith('version', 'desc');
    });
  });

  describe('getByVersion', () => {
    it('returns null for non-existent version', async () => {
      const { db } = createMockDb({ selectFirstRow: undefined });
      const store = new SharedConfigStore(db, null);

      const result = await store.getByVersion(999);
      expect(result).toBeNull();
    });

    it('returns the specified version', async () => {
      const row = makeDbRow({ version: 5 });
      const { db, mocks } = createMockDb({ selectFirstRow: row });
      const store = new SharedConfigStore(db, null);

      const result = await store.getByVersion(5);
      expect(result).not.toBeNull();
      expect(result!.version).toBe(5);
      expect(mocks.where).toHaveBeenCalledWith('version', '=', 5);
    });
  });

  describe('save', () => {
    it('validates config against sharedConfigSchema', async () => {
      const { db } = createMockDb({ insertReturning: { version: 1 } });
      const store = new SharedConfigStore(db, null);

      // Invalid config (invalid agentAuth value)
      await expect(store.save({ agentAuth: 'invalid-value' }, 'cli:test')).rejects.toThrow(
        'Shared config validation failed',
      );
    });

    it('saves valid config and returns version number', async () => {
      const { db, mocks } = createMockDb({ insertReturning: { version: 7 } });
      const store = new SharedConfigStore(db, null);

      const version = await store.save(makeSharedConfig(), 'cli:seed', 'Initial setup');

      expect(version).toBe(7);
      expect(db.insertInto).toHaveBeenCalledWith('config_versions');
    });

    it('encrypts sensitive fields when master key is available', async () => {
      const { db, mocks } = createMockDb({ insertReturning: { version: 1 } });
      const store = new SharedConfigStore(db, TEST_MASTER_KEY);

      await store.save(makeSharedConfig(), 'cli:seed');

      // Check the values passed to insertInto
      const valuesArg = mocks.values.mock.calls[0][0];
      const storedConfig = JSON.parse(valuesArg.config);

      // Encrypted fields should NOT be plaintext
      expect(storedConfig.platform.token).not.toBe('platform-token-secret');
      expect(storedConfig.secrets.key).not.toBe('test-master-key-value');

      // encrypted_paths should list the concrete paths
      expect(valuesArg.encrypted_paths).toContain('platform.token');
      expect(valuesArg.encrypted_paths).toContain('secrets.key');
      expect(valuesArg.encrypted_paths).toContain('secrets.bootstrapAdminToken');
    });

    it('skips encryption when no master key', async () => {
      const { db, mocks } = createMockDb({ insertReturning: { version: 1 } });
      const store = new SharedConfigStore(db, null);

      await store.save(makeSharedConfig(), 'cli:seed');

      const valuesArg = mocks.values.mock.calls[0][0];
      const storedConfig = JSON.parse(valuesArg.config);

      // Should be plaintext
      expect(storedConfig.platform.token).toBe('platform-token-secret');
      expect(storedConfig.secrets.key).toBe('test-master-key-value');
      expect(valuesArg.encrypted_paths).toEqual([]);
    });

    it('stores created_by and description', async () => {
      const { db, mocks } = createMockDb({ insertReturning: { version: 1 } });
      const store = new SharedConfigStore(db, null);

      await store.save(makeSharedConfig(), 'api:set', 'Updated provider config');

      const valuesArg = mocks.values.mock.calls[0][0];
      expect(valuesArg.created_by).toBe('api:set');
      expect(valuesArg.description).toBe('Updated provider config');
    });

    it('uses null description when not provided', async () => {
      const { db, mocks } = createMockDb({ insertReturning: { version: 1 } });
      const store = new SharedConfigStore(db, null);

      await store.save(makeSharedConfig(), 'cli:seed');

      const valuesArg = mocks.values.mock.calls[0][0];
      expect(valuesArg.description).toBeNull();
    });
  });

  describe('listHistory', () => {
    it('returns version metadata without config bodies', async () => {
      const rows = [
        {
          version: 3,
          created_at: new Date('2026-02-22T12:00:00Z'),
          created_by: 'api:set',
          description: 'Updated storage',
        },
        {
          version: 2,
          created_at: new Date('2026-02-22T11:00:00Z'),
          created_by: 'cli:seed',
          description: 'Added partner app',
        },
        {
          version: 1,
          created_at: new Date('2026-02-22T10:00:00Z'),
          created_by: 'cli:seed',
          description: 'Initial config',
        },
      ];

      const { db } = createMockDb({ selectRows: rows });

      // Override to use execute (not executeTakeFirst) for list queries
      const execute = vi.fn().mockResolvedValue(rows);
      const limit = vi.fn().mockReturnValue({ execute });
      const orderBy = vi.fn().mockReturnValue({ limit });
      const select = vi.fn().mockReturnValue({ orderBy });
      (db as any).selectFrom = vi.fn().mockReturnValue({ select });

      const store = new SharedConfigStore(db, null);
      const history = await store.listHistory();

      expect(history).toHaveLength(3);
      expect(history[0].version).toBe(3);
      expect(history[0].createdBy).toBe('api:set');
      expect(history[0].description).toBe('Updated storage');
    });

    it('respects custom limit', async () => {
      const { db } = createMockDb();

      const execute = vi.fn().mockResolvedValue([]);
      const limitMock = vi.fn().mockReturnValue({ execute });
      const orderBy = vi.fn().mockReturnValue({ limit: limitMock });
      const select = vi.fn().mockReturnValue({ orderBy });
      (db as any).selectFrom = vi.fn().mockReturnValue({ select });

      const store = new SharedConfigStore(db, null);
      await store.listHistory(10);

      expect(limitMock).toHaveBeenCalledWith(10);
    });
  });

  describe('rollback', () => {
    it('throws when target version does not exist', async () => {
      const { db } = createMockDb({ selectFirstRow: undefined });
      const store = new SharedConfigStore(db, null);

      await expect(store.rollback(999, 'cli:rollback')).rejects.toThrow(
        'Config version 999 not found',
      );
    });

    it('creates new version as copy of target', async () => {
      const targetRow = makeDbRow({
        version: 2,
        config: JSON.stringify({ agentAuth: 'none' }),
        encrypted_paths: ['platform.token'],
      });

      // First call: selectFrom for reading target version
      // Second call: insertInto for creating new version
      const executeTakeFirst = vi.fn().mockResolvedValue(targetRow);
      const limit = vi.fn().mockReturnValue({ executeTakeFirst });
      const orderBy = vi.fn().mockReturnValue({ executeTakeFirst, limit });
      const where = vi.fn().mockReturnValue({ executeTakeFirst, orderBy, limit });
      const selectAll = vi.fn().mockReturnValue({ where, orderBy, limit });

      const executeTakeFirstOrThrow = vi.fn().mockResolvedValue({ version: 5 });
      const returning = vi.fn().mockReturnValue({ executeTakeFirstOrThrow });
      const values = vi.fn().mockReturnValue({ returning });

      const db = {
        selectFrom: vi.fn().mockReturnValue({ selectAll }),
        insertInto: vi.fn().mockReturnValue({ values }),
      } as any;

      const store = new SharedConfigStore(db, null);
      const newVersion = await store.rollback(2, 'cli:rollback');

      expect(newVersion).toBe(5);
      expect(db.insertInto).toHaveBeenCalledWith('config_versions');

      const valuesArg = values.mock.calls[0][0];
      expect(valuesArg.config).toBe(targetRow.config);
      expect(valuesArg.encrypted_paths).toEqual(['platform.token']);
      expect(valuesArg.description).toBe('Rollback to version 2');
      expect(valuesArg.created_by).toBe('cli:rollback');
    });
  });

  describe('getCurrentVersion', () => {
    it('returns 0 when no versions exist', async () => {
      const { db } = createMockDb();

      const execute = vi.fn().mockResolvedValue([]);
      const executeTakeFirst = vi.fn().mockResolvedValue(undefined);
      const limit = vi.fn().mockReturnValue({ executeTakeFirst });
      const orderBy = vi.fn().mockReturnValue({ limit });
      const select = vi.fn().mockReturnValue({ orderBy });
      (db as any).selectFrom = vi.fn().mockReturnValue({ select });

      const store = new SharedConfigStore(db, null);
      const version = await store.getCurrentVersion();

      expect(version).toBe(0);
    });

    it('returns the latest version number', async () => {
      const { db } = createMockDb();

      const executeTakeFirst = vi.fn().mockResolvedValue({ version: 42 });
      const limit = vi.fn().mockReturnValue({ executeTakeFirst });
      const orderBy = vi.fn().mockReturnValue({ limit });
      const select = vi.fn().mockReturnValue({ orderBy });
      (db as any).selectFrom = vi.fn().mockReturnValue({ select });

      const store = new SharedConfigStore(db, null);
      const version = await store.getCurrentVersion();

      expect(version).toBe(42);
    });
  });

  describe('exportRedacted', () => {
    it('returns null when no versions exist', async () => {
      const { db } = createMockDb({ selectFirstRow: undefined });
      const store = new SharedConfigStore(db, null);

      const result = await store.exportRedacted();
      expect(result).toBeNull();
    });

    it('redacts sensitive fields', async () => {
      // Config with encrypted fields
      const plainConfig = makeSharedConfig();
      const { encrypted, encryptedPaths } = encryptConfigFields(
        plainConfig,
        [...SENSITIVE_FIELD_PATHS],
        TEST_MASTER_KEY,
        1,
      );

      const row = makeDbRow({
        config: JSON.stringify(encrypted),
        encrypted_paths: encryptedPaths,
      });

      const { db } = createMockDb({ selectFirstRow: row });
      const store = new SharedConfigStore(db, TEST_MASTER_KEY);

      const result = await store.exportRedacted();
      expect(result).not.toBeNull();

      // Sensitive fields should be redacted
      expect((result as any).platform.token).toBe('***REDACTED***');
      expect((result as any).secrets.key).toBe('***REDACTED***');
      expect((result as any).secrets.bootstrapAdminToken).toBe('***REDACTED***');

      // Non-sensitive fields should be visible
      expect((result as any).platform.url).toBe('wss://platform.kici.dev/ws');
      expect((result as any).agentAuth).toBe('token');
    });

    it('handles config without master key', async () => {
      const row = makeDbRow({
        config: JSON.stringify(makeSharedConfig()),
        encrypted_paths: [],
      });

      const { db } = createMockDb({ selectFirstRow: row });
      const store = new SharedConfigStore(db, null);

      const result = await store.exportRedacted();
      expect(result).not.toBeNull();

      // Without encrypted_paths, nothing is redacted
      expect((result as any).platform.token).toBe('platform-token-secret');
      expect((result as any).secrets.key).toBe('test-master-key-value');
    });
  });

  describe('encryption round-trip', () => {
    it('encrypts on save and decrypts on read', async () => {
      // Simulate save: encrypt config and store
      const plainConfig = makeSharedConfig();
      const { encrypted, encryptedPaths } = encryptConfigFields(
        plainConfig,
        [...SENSITIVE_FIELD_PATHS],
        TEST_MASTER_KEY,
        1,
      );

      // Verify encryption happened
      expect((encrypted as any).platform.token).not.toBe('platform-token-secret');

      // Simulate read: create row with encrypted data
      const row = makeDbRow({
        version: 1,
        config: JSON.stringify(encrypted),
        encrypted_paths: encryptedPaths,
      });

      const { db } = createMockDb({ selectFirstRow: row });
      const store = new SharedConfigStore(db, TEST_MASTER_KEY);

      // Read should decrypt
      const result = await store.getLatest();
      expect(result).not.toBeNull();
      expect(result!.config.platform?.token).toBe('platform-token-secret');
      expect(result!.config.secrets?.key).toBe('test-master-key-value');
      expect(result!.config.secrets?.bootstrapAdminToken).toBe('bootstrap-token-secret');
    });
  });

  // ── rotateKey tests ─────────────────────────────────────────────
  //
  // These tests use a stateful in-memory mock that supports:
  //   - selectFrom('config_versions').selectAll().execute()   (inside txn)
  //   - updateTable('config_versions').set().where().execute() (inside txn)
  //   - transaction().execute(cb) that calls cb with a trx referring to the
  //     same shared db object.
  //
  // This lets us exercise the full rotate-key flow — select rows, re-encrypt,
  // update rows — and read the resulting row state back via assertions.

  describe('rotateKey', () => {
    interface RotateRow {
      id: string;
      version: number;
      config: string;
      created_at: Date;
      created_by: string;
      description: string | null;
      encrypted_paths: string[];
      key_version: number;
    }

    function createRotateMockDb(initialRows: RotateRow[]): {
      db: any;
      rows: RotateRow[];
    } {
      const rows: RotateRow[] = [...initialRows];

      const db: any = {
        selectFrom: vi.fn().mockImplementation((table: string) => {
          expect(table).toBe('config_versions');
          return {
            selectAll: vi.fn().mockReturnValue({
              // Full-table scan (used by rotateKey)
              execute: vi.fn().mockImplementation(async () => [...rows]),
              // Latest-row read (used by getLatest)
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  executeTakeFirst: vi.fn().mockImplementation(async () => {
                    const sorted = [...rows].sort((a, b) => b.version - a.version);
                    return sorted[0];
                  }),
                }),
              }),
            }),
            select: vi.fn().mockReturnValue({
              executeTakeFirst: vi.fn().mockImplementation(async () => {
                const max = rows.reduce((m, r) => Math.max(m, r.key_version), 0);
                return { max_version: max || 1 };
              }),
            }),
          };
        }),
        updateTable: vi.fn().mockImplementation((table: string) => {
          expect(table).toBe('config_versions');
          return {
            set: vi.fn().mockImplementation((patch: Partial<RotateRow>) => ({
              where: vi.fn().mockImplementation((_col: string, _op: string, id: string) => ({
                execute: vi.fn().mockImplementation(async () => {
                  const target = rows.find((r) => r.id === id);
                  if (!target) throw new Error(`row ${id} not found`);
                  Object.assign(target, patch);
                }),
              })),
            })),
          };
        }),
        transaction: vi.fn().mockReturnValue({
          execute: vi.fn().mockImplementation(async (cb: (trx: any) => Promise<void>) => {
            await cb(db);
          }),
        }),
      };

      return { db, rows };
    }

    function seedRow(overrides: {
      id: string;
      version: number;
      config: Record<string, unknown>;
      encryptedPaths: string[];
      key: Buffer;
      keyVersion: number;
    }): RotateRow {
      const { encrypted, encryptedPaths } = encryptConfigFields(
        overrides.config,
        overrides.encryptedPaths,
        overrides.key,
        overrides.keyVersion,
      );
      return {
        id: overrides.id,
        version: overrides.version,
        config: JSON.stringify(encrypted),
        created_at: new Date('2026-02-22T10:00:00Z'),
        created_by: 'cli:seed',
        description: null,
        encrypted_paths: encryptedPaths,
        key_version: overrides.keyVersion,
      };
    }

    it('re-encrypts every row under the next key_version', async () => {
      const plainConfig = makeSharedConfig();
      const row = seedRow({
        id: 'r1',
        version: 1,
        config: plainConfig,
        encryptedPaths: [...SENSITIVE_FIELD_PATHS],
        key: TEST_MASTER_KEY,
        keyVersion: 1,
      });
      const originalConfigCiphertext = row.config;
      const { db, rows } = createRotateMockDb([row]);

      const store = new SharedConfigStore(db, TEST_MASTER_KEY, null, 1);
      const result = await store.rotateKey();

      expect(result.reEncrypted).toBe(1);
      expect(rows[0].key_version).toBe(2);

      // Ciphertext changed (fresh AES-GCM nonce) but is still non-plaintext.
      expect(rows[0].config).not.toBe(originalConfigCiphertext);
      const stored = JSON.parse(rows[0].config);
      expect(stored.platform.token).not.toBe('platform-token-secret');
      expect(stored.secrets.key).not.toBe('test-master-key-value');
    });

    it('decrypts old-key ciphertext via oldMasterKey fallback, then re-encrypts with current key', async () => {
      const OLD_KEY = randomBytes(32);
      const NEW_KEY = randomBytes(32);

      // Row was originally sealed under OLD_KEY at generation 1.
      const row = seedRow({
        id: 'r1',
        version: 1,
        config: makeSharedConfig(),
        encryptedPaths: [...SENSITIVE_FIELD_PATHS],
        key: OLD_KEY,
        keyVersion: 1,
      });
      const { db, rows } = createRotateMockDb([row]);

      // Current master key is NEW_KEY; OLD_KEY is the grace-window fallback.
      const store = new SharedConfigStore(db, NEW_KEY, OLD_KEY, 1);
      const result = await store.rotateKey();

      expect(result.reEncrypted).toBe(1);
      expect(rows[0].key_version).toBe(2);

      // After rotation, decrypting with NEW_KEY alone (no fallback) should work.
      const store2 = new SharedConfigStore(db, NEW_KEY, null, 2);
      const latest = await store2.getLatest();
      expect(latest!.config.platform?.token).toBe('platform-token-secret');
      expect(latest!.config.secrets?.key).toBe('test-master-key-value');
    });

    it('re-encrypts historical rows (v1..v3) so rollback survives old-key removal', async () => {
      const seeded: RotateRow[] = [];
      for (let v = 1; v <= 3; v++) {
        seeded.push(
          seedRow({
            id: `r${v}`,
            version: v,
            config: makeSharedConfig({ version: `v${v}` }),
            encryptedPaths: [...SENSITIVE_FIELD_PATHS],
            key: TEST_MASTER_KEY,
            keyVersion: 1,
          }),
        );
      }
      const { db, rows } = createRotateMockDb(seeded);

      const store = new SharedConfigStore(db, TEST_MASTER_KEY, null, 1);
      const result = await store.rotateKey();

      expect(result.reEncrypted).toBe(3);
      for (const r of rows) {
        expect(r.key_version).toBe(2);
      }
    });

    it('is idempotent: calling twice lands on key_version 3', async () => {
      const row = seedRow({
        id: 'r1',
        version: 1,
        config: makeSharedConfig(),
        encryptedPaths: [...SENSITIVE_FIELD_PATHS],
        key: TEST_MASTER_KEY,
        keyVersion: 1,
      });
      const { db, rows } = createRotateMockDb([row]);

      const store = new SharedConfigStore(db, TEST_MASTER_KEY, null, 1);
      await store.rotateKey();
      expect(rows[0].key_version).toBe(2);

      const second = await store.rotateKey();
      expect(second.reEncrypted).toBe(1);
      expect(rows[0].key_version).toBe(3);
    });

    it('returns { reEncrypted: 0, skipped: 0 } on an empty store without throwing', async () => {
      const { db } = createRotateMockDb([]);

      const store = new SharedConfigStore(db, TEST_MASTER_KEY, null, 1);
      const result = await store.rotateKey();

      expect(result.reEncrypted).toBe(0);
      expect(result.skipped).toBe(0);
    });

    it('skips undecryptable historical rows with a warning instead of aborting', async () => {
      // A polluted row whose ciphertext was sealed under some OTHER key that
      // we no longer hold (imagine a DB restored from a backup that pre-dates
      // today's KICI_SECRET_KEY, or a prior KICI_SECRET_KEY_OLD we retired
      // without finishing rotation). The current master key cannot decrypt
      // it, and no fallback key is configured. Rotation MUST NOT abort — it
      // should re-encrypt the decryptable row next to it and skip this one.
      const STRANGER_KEY = Buffer.alloc(32, 0xab);
      const undecryptableRow = seedRow({
        id: 'stale',
        version: 1,
        config: makeSharedConfig(),
        encryptedPaths: [...SENSITIVE_FIELD_PATHS],
        key: STRANGER_KEY,
        keyVersion: 1,
      });
      const goodRow = seedRow({
        id: 'current',
        version: 2,
        config: makeSharedConfig(),
        encryptedPaths: [...SENSITIVE_FIELD_PATHS],
        key: TEST_MASTER_KEY,
        keyVersion: 1,
      });
      const { db, rows } = createRotateMockDb([undecryptableRow, goodRow]);

      const store = new SharedConfigStore(db, TEST_MASTER_KEY, null, 1);
      const result = await store.rotateKey();

      expect(result.reEncrypted).toBe(1);
      expect(result.skipped).toBe(1);
      // Good row advanced to the new generation.
      expect(rows.find((r) => r.id === 'current')!.key_version).toBe(2);
      // Stale row was left alone (still on its original key_version and
      // ciphertext) — rotation didn't try to fabricate a new cipher text
      // out of thin air.
      expect(rows.find((r) => r.id === 'stale')!.key_version).toBe(1);
    });

    it('bumps key_version but skips the counter for rows with encrypted_paths = []', async () => {
      const rowWithCiphertext = seedRow({
        id: 'r1',
        version: 1,
        config: makeSharedConfig(),
        encryptedPaths: [...SENSITIVE_FIELD_PATHS],
        key: TEST_MASTER_KEY,
        keyVersion: 1,
      });
      const rowWithoutCiphertext: RotateRow = {
        id: 'r2',
        version: 2,
        config: JSON.stringify({ agentAuth: 'token' }),
        created_at: new Date('2026-02-22T10:00:00Z'),
        created_by: 'cli:seed',
        description: null,
        encrypted_paths: [],
        key_version: 1,
      };
      const { db, rows } = createRotateMockDb([rowWithCiphertext, rowWithoutCiphertext]);

      const store = new SharedConfigStore(db, TEST_MASTER_KEY, null, 1);
      const result = await store.rotateKey();

      // Only the ciphertext row counts — but both rows land on the new generation.
      expect(result.reEncrypted).toBe(1);
      expect(rows.find((r) => r.id === 'r1')!.key_version).toBe(2);
      expect(rows.find((r) => r.id === 'r2')!.key_version).toBe(2);
    });

    it('throws when no master key is configured', async () => {
      const { db } = createRotateMockDb([]);
      const store = new SharedConfigStore(db, null, null, 1);

      await expect(store.rotateKey()).rejects.toThrow(
        'Cannot rotate config store key: no master key configured',
      );
    });
  });
});
