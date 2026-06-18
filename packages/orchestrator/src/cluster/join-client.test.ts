import { randomBytes } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { deriveKeys, encryptBundle } from './join-token.js';
import { decryptAndParseBundle, buildLocalConfig, writeConfigFile } from './join-client.js';

describe('decryptAndParseBundle', () => {
  it('correctly decrypts a valid encrypted bundle using token-derived key', () => {
    const secret = randomBytes(32);
    const keys = deriveKeys(secret);
    const bundle = {
      databaseUrl: 'postgres://localhost/kici',
      clusterId: 'cluster-1',
      storage: { type: 's3' as const, bucket: 'my-bucket' },
      secretKey: 'secret-key-value',
    };

    const encrypted = encryptBundle(bundle, keys.encryptionKey);
    const encryptedB64 = encrypted.toString('base64');

    const result = decryptAndParseBundle(encryptedB64, keys.encryptionKey);
    expect(result).toEqual(bundle);
  });

  it('throws with wrong key', () => {
    const secret1 = randomBytes(32);
    const secret2 = randomBytes(32);
    const keys1 = deriveKeys(secret1);
    const keys2 = deriveKeys(secret2);

    const bundle = { databaseUrl: 'postgres://localhost/kici', clusterId: 'c1' };
    const encrypted = encryptBundle(bundle, keys1.encryptionKey);
    const encryptedB64 = encrypted.toString('base64');

    expect(() => decryptAndParseBundle(encryptedB64, keys2.encryptionKey)).toThrow();
  });
});

describe('buildLocalConfig', () => {
  it('creates a LocalConfig object from a ConfigBundle with all fields mapped (no PSK)', () => {
    const bundle = {
      databaseUrl: 'postgres://localhost/kici',
      clusterId: 'cluster-1',
      storage: {
        type: 's3' as const,
        bucket: 'my-bucket',
        prefix: 'kici/',
        region: 'us-east-1',
        endpoint: 'http://s3:9000',
        forcePathStyle: true,
        logBucket: 'logs',
      },
      secretKey: 'my-secret',
    };

    const config = buildLocalConfig(bundle);

    expect(config.database.url).toBe('postgres://localhost/kici');
    expect((config as any).cluster).toBeUndefined();
    expect(config.storage).toEqual(bundle.storage);
    expect(config.secrets).toEqual({ key: 'my-secret' });
  });

  it('handles missing optional fields (no storage, no secretKey)', () => {
    const bundle = {
      databaseUrl: 'postgres://localhost/kici',
      clusterId: 'cluster-1',
    };

    const config = buildLocalConfig(bundle);

    expect(config.database.url).toBe('postgres://localhost/kici');
    expect((config as any).cluster).toBeUndefined();
    expect(config.storage).toBeUndefined();
    expect(config.secrets).toBeUndefined();
  });
});

describe('writeConfigFile', () => {
  it('writes YAML to the specified path', async () => {
    const configPath = join(tmpdir(), `kici-test-config-${Date.now()}.yaml`);
    const config = {
      database: { url: 'postgres://localhost/kici' },
    };

    try {
      await writeConfigFile(configPath, config);
      const content = await readFile(configPath, 'utf-8');
      const parsed = parseYaml(content);
      expect(parsed.database.url).toBe('postgres://localhost/kici');
    } finally {
      await unlink(configPath).catch(() => {});
    }
  });
});

describe('JoinClient joinViaPeer', () => {
  it('sends POST to peer URL and returns parsed JoinResponse', async () => {
    const { JoinClient } = await import('./join-client.js');

    const mockResponse = {
      type: 'join.response' as const,
      success: true,
      encryptedBundle: 'base64data',
    };

    // Mock global fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    }) as any;

    try {
      const client = new JoinClient({
        token: 'kici_join_v1.dummyrouting.dummysecret',
        peerUrl: 'https://orch-1:8080',
      });

      const result = await (client as any).joinViaPeer({
        type: 'join.request',
        token: 'kici_join_v1.dummyrouting.dummysecret',
      });

      expect(result).toEqual(mockResponse);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://orch-1:8080/api/v1/cluster/join',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('JoinClient constructor validation', () => {
  it('throws when neither --platform nor --peer is specified', async () => {
    const { JoinClient } = await import('./join-client.js');
    expect(() => new JoinClient({ token: 'kici_join_v1.x.y' })).toThrow(
      'Either --platform or --peer must be specified',
    );
  });

  it('throws when both --platform and --peer are specified', async () => {
    const { JoinClient } = await import('./join-client.js');
    expect(
      () =>
        new JoinClient({
          token: 'kici_join_v1.x.y',
          platformUrl: 'wss://platform',
          peerUrl: 'https://peer',
        }),
    ).toThrow('--platform and --peer are mutually exclusive');
  });
});
