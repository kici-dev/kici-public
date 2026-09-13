import { randomBytes } from 'node:crypto';
import { existsSync, linkSync, statSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { envDef, loadConfig } from '../config.js';
import { sharedConfigSchema } from '../config/schema.js';
import { deriveKeys, encryptBundle } from './join-token.js';
import {
  STORAGE_ENV_VARS,
  buildEnvFile,
  buildLocalConfig,
  decryptAndParseBundle,
  writeConfigFile,
  writeEnvFile,
} from './join-client.js';

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

/**
 * Parse an env file the way systemd's `EnvironmentFile=` and
 * `docker --env-file` do: skip blanks and `#` comments, split on the first
 * `=`. Used to cross the seam between the join writer and `loadConfig()`
 * instead of asserting the writer's own output back at itself.
 */
function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return env;
}

describe('buildEnvFile', () => {
  // fails-when: sharedConfigSchema.storage gains a field with no STORAGE_ENV_VARS
  //   entry. The join would then carry that field across the wire and drop it
  //   on the floor — silently, which is the whole defect this projection closes.
  //   The two sides are authored independently (a Zod schema vs a hand-written
  //   map), so agreement is a real claim rather than a restatement.
  it('projects every field the shared storage schema accepts', () => {
    const storageShape = (sharedConfigSchema.shape.storage.unwrap() as z.ZodObject<z.ZodRawShape>)
      .shape;

    expect(Object.keys(STORAGE_ENV_VARS).sort()).toEqual(Object.keys(storageShape).sort());
  });

  // fails-when: a variable in the projection is not one the startup path reads
  //   — the value would be written and then rejected by the boot-time
  //   unknown-KICI_* check, or accepted and ignored.
  it('names only variables the startup env definition declares', () => {
    const declared = new Set(envDef.describe().map((row) => row.envVar));

    for (const envVar of [
      'KICI_DATABASE_URL',
      'KICI_SECRET_KEY',
      ...Object.values(STORAGE_ENV_VARS),
    ]) {
      expect(declared.has(envVar), `${envVar} is not a startup variable`).toBe(true);
    }
  });

  // fails-when: nothing delivers the bundle to the boot path. Before this
  //   change no artifact reached loadConfig() with any of these three values —
  //   the YAML was ignored at startup and stripped by the one loader that read
  //   it. Asserting the emitted lines back at the writer would prove nothing.
  it('delivers the bundle to loadConfig() through the environment', () => {
    const bundle = {
      databaseUrl: 'postgresql://joiner:pw@db:5432/kici',
      clusterId: 'cluster-1',
      storage: {
        type: 's3' as const,
        bucket: 'kici-cache',
        prefix: 'kici/',
        region: 'us-east-1',
        endpoint: 'http://s3:9000',
        externalEndpoint: 'http://s3.example:9000',
        forcePathStyle: true,
        logBucket: 'kici-logs',
      },
      secretKey: 'a'.repeat(64),
    };

    const originalEnv = process.env;
    try {
      process.env = { ...originalEnv };
      for (const key of Object.keys(process.env)) {
        if (key.startsWith('KICI_')) delete process.env[key];
      }
      process.env.KICI_MODE = 'independent';
      Object.assign(process.env, parseEnvFile(buildEnvFile(bundle)));

      const config = loadConfig();

      expect(config.databaseUrl).toBe(bundle.databaseUrl);
      expect(config.secretKey).toBe(bundle.secretKey);
      expect(config.storage).toMatchObject({
        type: 's3',
        bucket: 'kici-cache',
        prefix: 'kici/',
        region: 'us-east-1',
        endpoint: 'http://s3:9000',
        externalEndpoint: 'http://s3.example:9000',
        forcePathStyle: true,
        logBucket: 'kici-logs',
      });
    } finally {
      process.env = originalEnv;
    }
  });

  // breaks-if-wrong: a fresh cluster whose shared document is empty must still
  //   produce a bootable env file. An unguarded projection would emit
  //   `KICI_STORAGE_TYPE=undefined`, which is fatal at startup — the exact
  //   failure shape this change exists to remove.
  it('emits only the database URL for an empty shared document', () => {
    const content = buildEnvFile({
      databaseUrl: 'postgresql://joiner:pw@db:5432/kici',
      clusterId: 'cluster-1',
    });

    expect(parseEnvFile(content)).toEqual({
      KICI_DATABASE_URL: 'postgresql://joiner:pw@db:5432/kici',
    });

    const originalEnv = process.env;
    try {
      process.env = { ...originalEnv };
      for (const key of Object.keys(process.env)) {
        if (key.startsWith('KICI_')) delete process.env[key];
      }
      process.env.KICI_MODE = 'independent';
      Object.assign(process.env, parseEnvFile(content));

      expect(() => loadConfig()).not.toThrow();
    } finally {
      process.env = originalEnv;
    }
  });

  // fails-when: a value carrying a line break is written verbatim, which
  //   truncates the file at that point and silently drops every later line.
  it('refuses a value carrying a line break', () => {
    expect(() =>
      buildEnvFile({
        databaseUrl: 'postgresql://db/kici\nKICI_SECRET_KEY=injected',
        clusterId: 'c1',
      }),
    ).toThrow(/KICI_DATABASE_URL contains a line break/);
  });
});

describe('writeEnvFile', () => {
  // fails-when: the file is written under the ambient umask (0644 by default)
  //   while carrying the cluster's master secret key and database URL.
  it('writes the env file readable by its owner only', async () => {
    const envPath = join(tmpdir(), `kici-test-join-${Date.now()}.env`);
    try {
      await writeEnvFile(envPath, {
        databaseUrl: 'postgresql://db/kici',
        clusterId: 'c1',
        secretKey: 'b'.repeat(64),
      });

      expect(statSync(envPath).mode & 0o777).toBe(0o600);
      // breaks-if-wrong: the installing user must still be able to read it back
      // and hand it to `orchestrator install --env-file`.
      expect(await readFile(envPath, 'utf-8')).toContain('KICI_DATABASE_URL=postgresql://db/kici');
    } finally {
      await unlink(envPath).catch(() => {});
    }
  });

  it('tightens a file that already existed with looser permissions', async () => {
    const envPath = join(tmpdir(), `kici-test-join-loose-${Date.now()}.env`);
    const keeperPath = `${envPath}.keeper`;
    try {
      await writeFile(envPath, 'stale\n', { encoding: 'utf-8', mode: 0o644 });
      await chmod(envPath, 0o644);
      // A second name for the same inode. If the write goes through it, the
      // database URL and the secret key land on a 0644 file and stay there
      // until a chmod behind the write catches up.
      // fails-when: writeSecretFile writes in place and chmods afterwards.
      linkSync(envPath, keeperPath);

      await writeEnvFile(envPath, { databaseUrl: 'postgresql://db/kici', clusterId: 'c1' });

      expect(statSync(envPath).mode & 0o777).toBe(0o600);
      expect(await readFile(keeperPath, 'utf-8')).toBe('stale\n');
      expect(statSync(envPath).ino).not.toBe(statSync(keeperPath).ino);
    } finally {
      await unlink(envPath).catch(() => {});
      await unlink(keeperPath).catch(() => {});
    }
  });
});

describe('writeConfigFile (deprecated --config path)', () => {
  // breaks-if-wrong: the deprecated artifact keeps its exact content, so an
  //   operator script that parses it is unaffected by the default moving to
  //   the env file. Pinned verbatim rather than round-tripped, since a
  //   round-trip would pass against a reformatted file too.
  it('writes byte-identical YAML', async () => {
    const configPath = join(tmpdir(), `kici-test-join-${Date.now()}.yaml`);
    try {
      const bundle = {
        databaseUrl: 'postgres://localhost/kici',
        clusterId: 'cluster-1',
        storage: { type: 's3' as const, bucket: 'my-bucket' },
        secretKey: 'my-secret',
      };
      await writeConfigFile(
        configPath,
        buildLocalConfig(bundle) as unknown as Record<string, unknown>,
      );

      expect(await readFile(configPath, 'utf-8')).toBe(
        [
          'database:',
          '  url: postgres://localhost/kici',
          'storage:',
          '  type: s3',
          '  bucket: my-bucket',
          'secrets:',
          '  key: my-secret',
          '',
        ].join('\n'),
      );
    } finally {
      await unlink(configPath).catch(() => {});
    }
  });

  // fails-when: the deprecated artifact keeps the 0644 it used to be written
  //   with, while carrying the same master secret key as the env file.
  it('writes the YAML readable by its owner only', async () => {
    const configPath = join(tmpdir(), `kici-test-join-mode-${Date.now()}.yaml`);
    try {
      await writeConfigFile(configPath, { database: { url: 'postgres://localhost/kici' } });
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
    } finally {
      await unlink(configPath).catch(() => {});
    }
  });
});

describe('JoinClient artifact selection', () => {
  function makeToken(): { token: string; encryptionKey: Buffer } {
    const secret = randomBytes(32);
    const routing = Buffer.from(
      JSON.stringify({ orgId: 'org', routingKey: 'rk', expiry: Date.now() + 60_000 }),
    ).toString('base64url');
    return {
      token: `kici_join_v1.${routing}.${secret.toString('hex')}`,
      encryptionKey: deriveKeys(secret).encryptionKey,
    };
  }

  async function runJoin(options: { configPath?: string; envFilePath?: string }): Promise<void> {
    const { JoinClient } = await import('./join-client.js');
    const { token, encryptionKey } = makeToken();
    const bundle = {
      databaseUrl: 'postgresql://joiner:pw@db:5432/kici',
      clusterId: 'cluster-1',
      storage: { type: 's3' as const, bucket: 'kici-cache' },
      secretKey: 'c'.repeat(64),
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          type: 'join.response',
          success: true,
          encryptedBundle: encryptBundle(bundle, encryptionKey).toString('base64'),
        }),
    }) as unknown as typeof fetch;
    try {
      await new JoinClient({ token, peerUrl: 'https://orch-1:8080', ...options }).join();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // fails-when: the join keeps writing only the YAML no boot path reads. The
  //   default artifact is the one `orchestrator install --env-file` consumes.
  it('writes only the env file when no artifact flag is passed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kici-join-default-'));
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      await runJoin({});
      expect(existsSync(join(dir, 'kici-orchestrator.env'))).toBe(true);
      expect(existsSync(join(dir, 'kici-orchestrator.yaml'))).toBe(false);
    } finally {
      process.chdir(cwd);
      await rm(dir, { recursive: true, force: true });
    }
  });

  // breaks-if-wrong: an operator whose script passes --config keeps getting
  //   exactly the file they asked for, and no surprise second artifact.
  it('writes only the YAML when --config names one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kici-join-config-'));
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      await runJoin({ configPath: join(dir, 'legacy.yaml') });
      expect(existsSync(join(dir, 'legacy.yaml'))).toBe(true);
      expect(existsSync(join(dir, 'kici-orchestrator.env'))).toBe(false);
    } finally {
      process.chdir(cwd);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes both when both flags are passed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kici-join-both-'));
    try {
      await runJoin({ configPath: join(dir, 'legacy.yaml'), envFilePath: join(dir, 'peer.env') });
      expect(existsSync(join(dir, 'legacy.yaml'))).toBe(true);
      expect(existsSync(join(dir, 'peer.env'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
