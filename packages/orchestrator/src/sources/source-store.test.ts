import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SourceStore } from './source-store.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';

// ── Mock helpers ──────────────────────────────────────────────────

function createMockSecretStore() {
  return {
    setSecret: vi.fn().mockResolvedValue(undefined),
    getSecrets: vi.fn().mockResolvedValue({}),
    deleteSecret: vi.fn().mockResolvedValue(undefined),
    listKeys: vi.fn().mockResolvedValue([]),
    listScopes: vi.fn().mockResolvedValue([]),
    getAllSecrets: vi.fn().mockResolvedValue([]),
    decryptValue: vi.fn().mockReturnValue(''),
    rotateKey: vi.fn().mockResolvedValue({ reEncrypted: 0 }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe('SourceStore', () => {
  let secretStore: ReturnType<typeof createMockSecretStore>;

  beforeEach(() => {
    secretStore = createMockSecretStore();
  });

  describe('addSource()', () => {
    it('inserts row into sources table and stores secrets in PgSecretStore', async () => {
      const insertedRow = {
        id: 'source-uuid-1',
        provider: 'github',
        name: 'My GitHub App',
        routing_key: 'github:12345',
        config: JSON.stringify({ appId: '12345' }),
        created_at: new Date(),
        updated_at: new Date(),
      };
      // selectFirstRow = undefined means no duplicate found
      const { db, mocks } = createMockDb({ insertedRow, selectFirstRow: undefined });
      const store = new SourceStore(db, secretStore as any);

      const result = await store.addSource({
        provider: 'github',
        name: 'My GitHub App',
        appId: '12345',
        privateKey: 'PEM-KEY-DATA',
        webhookSecret: 'whsec_abc123',
      });

      expect(mocks.insertInto).toHaveBeenCalledWith('sources');
      expect(secretStore.setSecret).toHaveBeenCalledWith(
        '__system__',
        '__source__/source-uuid-1',
        'privateKey',
        'PEM-KEY-DATA',
      );
      expect(secretStore.setSecret).toHaveBeenCalledWith(
        '__system__',
        '__source__/source-uuid-1',
        'webhookSecret',
        'whsec_abc123',
      );
      expect(result).toEqual(insertedRow);
    });

    it('computes routing_key as provider:appId', async () => {
      const insertedRow = {
        id: 'source-uuid-2',
        provider: 'github',
        name: 'Test App',
        routing_key: 'github:99999',
        config: JSON.stringify({ appId: '99999' }),
        created_at: new Date(),
        updated_at: new Date(),
      };
      const { db, mocks } = createMockDb({ insertedRow, selectFirstRow: undefined });
      const store = new SourceStore(db, secretStore as any);

      await store.addSource({
        provider: 'github',
        name: 'Test App',
        appId: '99999',
        privateKey: 'key',
      });

      // Verify the values passed to insertInto contain routing_key
      const valuesCall = mocks.insertValues.mock.calls[0][0];
      expect(valuesCall.routing_key).toBe('github:99999');
    });

    it('stores explicit appId even if config contains appId', async () => {
      const insertedRow = {
        id: 'source-uuid-3',
        provider: 'github',
        name: 'Override App',
        routing_key: 'github:42',
        config: JSON.stringify({ appId: '42' }),
        created_at: new Date(),
        updated_at: new Date(),
      };
      const { db, mocks } = createMockDb({ insertedRow, selectFirstRow: undefined });
      const store = new SourceStore(db, secretStore as any);

      await store.addSource({
        provider: 'github',
        name: 'Override App',
        appId: '42',
        privateKey: 'key',
        config: { appId: 'wrong-id', extra: 'data' },
      });

      const valuesCall = mocks.insertValues.mock.calls[0][0];
      const parsedConfig = JSON.parse(valuesCall.config as string);
      // Explicit appId must always win over config.appId
      expect(parsedConfig.appId).toBe('42');
      expect(parsedConfig.extra).toBe('data');
    });

    it('rejects duplicate routing_key with meaningful error', async () => {
      // Simulate existing source found by selectTakeFirst
      const existingSource = {
        id: 's1',
        provider: 'github',
        name: 'Existing App',
        routing_key: 'github:12345',
        config: '{}',
        created_at: new Date(),
        updated_at: new Date(),
      };
      const { db } = createMockDb({ selectFirstRow: existingSource });
      const store = new SourceStore(db, secretStore as any);

      await expect(
        store.addSource({
          provider: 'github',
          name: 'Dup App',
          appId: '12345',
          privateKey: 'key',
        }),
      ).rejects.toThrow(/already exists/);
    });
  });

  describe('listSources()', () => {
    it('returns all sources without secrets', async () => {
      const sources = [
        {
          id: 's1',
          provider: 'github',
          name: 'App 1',
          routing_key: 'github:111',
          config: '{}',
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          id: 's2',
          provider: 'github',
          name: 'App 2',
          routing_key: 'github:222',
          config: '{}',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];
      const { db, mocks } = createMockDb({ selectRows: sources });
      const store = new SourceStore(db, secretStore as any);

      const result = await store.listSources();

      expect(mocks.selectFrom).toHaveBeenCalledWith('sources');
      expect(result).toEqual(sources);
      expect(secretStore.getSecrets).not.toHaveBeenCalled();
    });
  });

  describe('getSource()', () => {
    it('returns single source by routing key', async () => {
      const source = {
        id: 's1',
        provider: 'github',
        name: 'App 1',
        routing_key: 'github:111',
        config: '{}',
        created_at: new Date(),
        updated_at: new Date(),
      };
      const { db } = createMockDb({ selectFirstRow: source });
      const store = new SourceStore(db, secretStore as any);

      const result = await store.getSource('github:111');

      expect(result).toEqual(source);
    });

    it('returns null when source not found', async () => {
      const { db } = createMockDb({ selectFirstRow: undefined });
      const store = new SourceStore(db, secretStore as any);

      const result = await store.getSource('github:unknown');

      expect(result).toBeNull();
    });
  });

  describe('getSourceWithSecrets()', () => {
    it('returns source merged with decrypted secrets', async () => {
      const source = {
        id: 's1',
        provider: 'github',
        name: 'App 1',
        routing_key: 'github:111',
        config: '{}',
        created_at: new Date(),
        updated_at: new Date(),
      };
      const { db } = createMockDb({ selectFirstRow: source });
      secretStore.getSecrets.mockResolvedValueOnce({
        privateKey: 'decrypted-private-key',
        webhookSecret: 'decrypted-webhook-secret',
      });
      const store = new SourceStore(db, secretStore as any);

      const result = await store.getSourceWithSecrets('github:111');

      expect(result).toEqual({
        ...source,
        privateKey: 'decrypted-private-key',
        webhookSecret: 'decrypted-webhook-secret',
      });
      expect(secretStore.getSecrets).toHaveBeenCalledWith('__system__', '__source__/s1');
    });

    it('returns null when source not found', async () => {
      const { db } = createMockDb({ selectFirstRow: undefined });
      const store = new SourceStore(db, secretStore as any);

      const result = await store.getSourceWithSecrets('github:unknown');

      expect(result).toBeNull();
    });

    it('returns null and logs error when private key is missing from secret store', async () => {
      const source = {
        id: 's1',
        provider: 'github',
        name: 'App 1',
        routing_key: 'github:111',
        config: '{}',
        created_at: new Date(),
        updated_at: new Date(),
      };
      const { db } = createMockDb({ selectFirstRow: source });
      // Secret store returns no privateKey
      secretStore.getSecrets.mockResolvedValueOnce({});
      const store = new SourceStore(db, secretStore as any);

      const result = await store.getSourceWithSecrets('github:111');

      expect(result).toBeNull();
    });
  });

  describe('updateSource()', () => {
    it('updates name and config fields', async () => {
      const existingSource = {
        id: 's1',
        provider: 'github',
        name: 'App 1',
        routing_key: 'github:111',
        config: '{"appId":"111"}',
        created_at: new Date(),
        updated_at: new Date(),
      };
      const updatedRow = {
        ...existingSource,
        name: 'Updated Name',
      };
      const { db, mocks } = createMockDb({
        selectFirstRow: existingSource,
        updatedRow,
      });
      const store = new SourceStore(db, secretStore as any);

      const result = await store.updateSource('github:111', { name: 'Updated Name' });

      expect(mocks.updateTable).toHaveBeenCalledWith('sources');
      expect(result).toEqual(updatedRow);
    });

    it('sets updated_at on every update', async () => {
      const source = {
        id: 's1',
        provider: 'github',
        name: 'App 1',
        routing_key: 'github:111',
        config: '{}',
        created_at: new Date(),
        updated_at: new Date(),
      };
      const { db, mocks } = createMockDb({
        selectFirstRow: source,
        updatedRow: { ...source, name: 'New Name' },
      });
      const store = new SourceStore(db, secretStore as any);

      await store.updateSource('github:111', { name: 'New Name' });

      const setArg = mocks.updateSet.mock.calls[0][0];
      expect(setArg).toHaveProperty('updated_at');
    });

    it('updates updated_at even when only secrets change', async () => {
      const source = {
        id: 's1',
        provider: 'github',
        name: 'App 1',
        routing_key: 'github:111',
        config: '{}',
        created_at: new Date(),
        updated_at: new Date(),
      };
      const { db, mocks } = createMockDb({
        selectFirstRow: source,
        updatedRow: source,
      });
      const store = new SourceStore(db, secretStore as any);

      await store.updateSource('github:111', { privateKey: 'new-key' });

      expect(mocks.updateTable).toHaveBeenCalledWith('sources');
      const setArg = mocks.updateSet.mock.calls[0][0];
      expect(setArg).toHaveProperty('updated_at');
    });

    it('merges config with existing values instead of replacing', async () => {
      const source = {
        id: 's1',
        provider: 'github',
        name: 'App 1',
        routing_key: 'github:111',
        config: JSON.stringify({ appId: '111', existingField: 'keep' }),
        created_at: new Date(),
        updated_at: new Date(),
      };
      const { db, mocks } = createMockDb({
        selectFirstRow: source,
        updatedRow: source,
      });
      const store = new SourceStore(db, secretStore as any);

      await store.updateSource('github:111', { config: { newField: 'added' } });

      const setArg = mocks.updateSet.mock.calls[0][0];
      const parsedConfig = JSON.parse(setArg.config as string);
      expect(parsedConfig).toEqual({ appId: '111', existingField: 'keep', newField: 'added' });
    });

    it('strips appId from config updates to prevent routing key mismatch', async () => {
      const source = {
        id: 's1',
        provider: 'github',
        name: 'App 1',
        routing_key: 'github:111',
        config: JSON.stringify({ appId: '111', existingField: 'keep' }),
        created_at: new Date(),
        updated_at: new Date(),
      };
      const { db, mocks } = createMockDb({
        selectFirstRow: source,
        updatedRow: source,
      });
      const store = new SourceStore(db, secretStore as any);

      await store.updateSource('github:111', {
        config: { appId: 'should-be-stripped', newField: 'added' },
      });

      const setArg = mocks.updateSet.mock.calls[0][0];
      const parsedConfig = JSON.parse(setArg.config as string);
      // appId must remain unchanged (from existing config), not overwritten
      expect(parsedConfig.appId).toBe('111');
      expect(parsedConfig.newField).toBe('added');
      expect(parsedConfig.existingField).toBe('keep');
    });

    it('rotates secrets when privateKey or webhookSecret provided', async () => {
      const source = {
        id: 's1',
        provider: 'github',
        name: 'App 1',
        routing_key: 'github:111',
        config: '{}',
        created_at: new Date(),
        updated_at: new Date(),
      };
      const { db } = createMockDb({
        selectFirstRow: source,
        updatedRow: source,
      });
      const store = new SourceStore(db, secretStore as any);

      await store.updateSource('github:111', {
        privateKey: 'new-private-key',
        webhookSecret: 'new-webhook-secret',
      });

      expect(secretStore.setSecret).toHaveBeenCalledWith(
        '__system__',
        '__source__/s1',
        'privateKey',
        'new-private-key',
      );
      expect(secretStore.setSecret).toHaveBeenCalledWith(
        '__system__',
        '__source__/s1',
        'webhookSecret',
        'new-webhook-secret',
      );
    });
  });

  describe('removeSource()', () => {
    it('deletes from sources table AND deletes PgSecretStore secrets', async () => {
      const source = {
        id: 's1',
        provider: 'github',
        name: 'App 1',
        routing_key: 'github:111',
        config: '{}',
        created_at: new Date(),
        updated_at: new Date(),
      };
      const { db, mocks } = createMockDb({ selectFirstRow: source });
      const store = new SourceStore(db, secretStore as any);

      await store.removeSource('github:111');

      expect(mocks.deleteFrom).toHaveBeenCalledWith('sources');
      expect(secretStore.deleteSecret).toHaveBeenCalledWith(
        '__system__',
        '__source__/s1',
        'privateKey',
      );
      expect(secretStore.deleteSecret).toHaveBeenCalledWith(
        '__system__',
        '__source__/s1',
        'webhookSecret',
      );
    });

    it('does nothing when source not found', async () => {
      const { db, mocks } = createMockDb({ selectFirstRow: undefined });
      const store = new SourceStore(db, secretStore as any);

      await store.removeSource('github:unknown');

      expect(mocks.deleteFrom).not.toHaveBeenCalled();
      expect(secretStore.deleteSecret).not.toHaveBeenCalled();
    });
  });
});
