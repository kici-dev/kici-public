import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../agent-packaging/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent-packaging/index.js')>()),
  refreshAgentPackages: vi.fn(async () => ({ produced: [], skipped: [] })),
}));

import { refreshAgentPackages } from '../../agent-packaging/index.js';
import {
  cacheBucketStorage,
  parsePlatforms,
  resolveUploadStorage,
  runAgentPackageRefresh,
  s3CredentialOptions,
  shellStorageEnv,
  storageEnvFromEnvFile,
} from './agent-package.js';

describe('parsePlatforms', () => {
  it('defaults to the glibc-Linux bootstrap set', () => {
    expect(parsePlatforms(undefined)).toEqual(['linux-x64', 'linux-arm64']);
  });
  it('accepts a single platform', () => {
    expect(parsePlatforms('linux-arm64')).toEqual(['linux-arm64']);
  });
  it('accepts a CSV', () => {
    expect(parsePlatforms('linux-x64,linux-arm64')).toEqual(['linux-x64', 'linux-arm64']);
  });
  it('expands `all` to every supported platform', () => {
    expect(parsePlatforms('all')).toEqual(['linux-x64', 'linux-arm64']);
  });
  it('throws on an unsupported platform', () => {
    expect(() => parsePlatforms('darwin-arm64')).toThrow(/unsupported/i);
  });
});

/** An instance env file the way `orchestrator install --env-file` leaves it. */
const STORAGE_ENV_FILE = [
  'KICI_DATABASE_URL=postgres://kici:pw@127.0.0.1:5432/kici',
  'KICI_PORT=not-a-port',
  '# the cache bucket',
  'KICI_STORAGE_TYPE=s3',
  'KICI_STORAGE_BUCKET="instance-bucket"',
  'KICI_STORAGE_ENDPOINT=http://127.0.0.1:8333',
  'KICI_STORAGE_FORCE_PATH_STYLE=true',
  'AWS_REGION=eu-central-1',
  'AWS_ACCESS_KEY_ID=instance-key',
  'AWS_SECRET_ACCESS_KEY=instance-secret',
  '',
].join('\n');

const NO_STORAGE_ENV_FILE = [
  'KICI_DATABASE_URL=postgres://kici:pw@127.0.0.1:5432/kici',
  'KICI_PORT=4000',
  '',
].join('\n');

/** The private fields of the S3 cache storage a test reads back. */
interface S3StorageInternals {
  bucket: string;
  client: {
    config: {
      region: () => Promise<string>;
      credentials: () => Promise<{ accessKeyId: string }>;
    };
  };
}

/** Clear every storage and AWS variable of the test process: an upgrade shell that exports none. */
function clearShellStorageEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('KICI_STORAGE_') || key.startsWith('AWS_')) vi.stubEnv(key, undefined);
  }
}

describe('instance storage config', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-agent-package-test-'));
    clearShellStorageEnv();
    vi.mocked(refreshAgentPackages).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeEnvFile(content: string): string {
    const file = path.join(dir, 'orchestrator.env');
    fs.writeFileSync(file, content);
    return file;
  }

  describe('storageEnvFromEnvFile', () => {
    it('reads only the storage and AWS variables, with quotes stripped', () => {
      const file = writeEnvFile(STORAGE_ENV_FILE);
      const source = storageEnvFromEnvFile(file);
      // fails-when: the reader keeps unrelated keys (KICI_PORT=not-a-port
      // would then fail the packaging config parse) or keeps the quotes.
      expect(source.env).toEqual({
        KICI_STORAGE_TYPE: 's3',
        KICI_STORAGE_BUCKET: 'instance-bucket',
        KICI_STORAGE_ENDPOINT: 'http://127.0.0.1:8333',
        KICI_STORAGE_FORCE_PATH_STYLE: 'true',
        AWS_REGION: 'eu-central-1',
        AWS_ACCESS_KEY_ID: 'instance-key',
        AWS_SECRET_ACCESS_KEY: 'instance-secret',
      });
      expect(source.origin).toBe(`the env file ${file}`);
    });

    it('names the path, and never the content, when the file cannot be read', () => {
      const missing = path.join(dir, 'absent.env');
      // fails-when: an unreadable env file reads as "no storage" and the
      // refresh skips silently.
      expect(() => storageEnvFromEnvFile(missing)).toThrow(
        `cannot read the env file ${missing} (ENOENT)`,
      );
      const secretContent = 'AWS_SECRET_ACCESS_KEY=leak-me';
      let message = '';
      try {
        storageEnvFromEnvFile('/x.env', () => {
          throw Object.assign(new Error(secretContent), { code: 'EACCES' });
        });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toBe('cannot read the env file /x.env (EACCES)');
      expect(message).not.toContain('leak-me');
    });
  });

  describe('s3CredentialOptions', () => {
    it('takes static keys, with the session token when set', () => {
      expect(
        s3CredentialOptions({
          AWS_ACCESS_KEY_ID: 'k',
          AWS_SECRET_ACCESS_KEY: 's',
          AWS_SESSION_TOKEN: 't',
          AWS_PROFILE: 'ignored',
        }),
      ).toEqual({ credentials: { accessKeyId: 'k', secretAccessKey: 's', sessionToken: 't' } });
    });

    it('falls back to the profile when the keys are incomplete', () => {
      // fails-when: a key id without its secret becomes half a credential.
      expect(s3CredentialOptions({ AWS_ACCESS_KEY_ID: 'k', AWS_PROFILE: 'cache' })).toEqual({
        profile: 'cache',
      });
    });

    it('reads AWS_REGION, else AWS_DEFAULT_REGION', () => {
      expect(s3CredentialOptions({ AWS_DEFAULT_REGION: 'us-west-2' })).toEqual({
        region: 'us-west-2',
      });
      expect(
        s3CredentialOptions({ AWS_REGION: 'eu-west-1', AWS_DEFAULT_REGION: 'us-west-2' }),
      ).toEqual({ region: 'eu-west-1' });
      // breaks-if-wrong: no AWS_* variable leaves the SDK default chain alone.
      expect(s3CredentialOptions({})).toEqual({});
    });
  });

  describe('cacheBucketStorage', () => {
    it('builds the bucket client from the env file alone, with its credentials', async () => {
      // The shell holds other credentials: the env file's must win.
      vi.stubEnv('AWS_ACCESS_KEY_ID', 'shell-key');
      vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'shell-secret');
      const storage = cacheBucketStorage(
        storageEnvFromEnvFile(writeEnvFile(STORAGE_ENV_FILE)),
      ) as unknown as S3StorageInternals | null;
      // fails-when: the storage config is read from the shell, which sets no
      // KICI_STORAGE_TYPE, so the client is null.
      expect(storage).not.toBeNull();
      expect(storage!.bucket).toBe('instance-bucket');
      // fails-when: the env file's AWS_* keys do not reach the S3 client.
      await expect(storage!.client.config.credentials()).resolves.toMatchObject({
        accessKeyId: 'instance-key',
      });
      await expect(storage!.client.config.region()).resolves.toBe('eu-central-1');
    });

    it('returns null for an env file with no storage', () => {
      expect(cacheBucketStorage(storageEnvFromEnvFile(writeEnvFile(NO_STORAGE_ENV_FILE)))).toBe(
        null,
      );
    });

    it('keeps reading the shell for the shell source', () => {
      vi.stubEnv('KICI_STORAGE_TYPE', 's3');
      vi.stubEnv('KICI_STORAGE_BUCKET', 'shell-bucket');
      const storage = cacheBucketStorage(shellStorageEnv()) as unknown as S3StorageInternals;
      // breaks-if-wrong: `agent package --upload` with no --env-file still reads the shell.
      expect(storage.bucket).toBe('shell-bucket');
    });
  });

  describe('resolveUploadStorage', () => {
    it('names the source that sets no S3 backend', () => {
      const file = writeEnvFile(NO_STORAGE_ENV_FILE);
      expect(() => resolveUploadStorage(storageEnvFromEnvFile(file))).toThrow(
        `--upload requires an S3 cache storage backend, and the env file ${file} sets none`,
      );
    });
  });

  describe('runAgentPackageRefresh', () => {
    it('refreshes from an env file with storage when the shell sets none', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const file = writeEnvFile(STORAGE_ENV_FILE);

      const ran = await runAgentPackageRefresh({ storageEnv: storageEnvFromEnvFile(file) });

      // fails-when: the refresh reads the shell's (empty) storage config and
      // skips, as it did for a native service install.
      expect(ran).toBe(true);
      expect(refreshAgentPackages).toHaveBeenCalledTimes(1);
      const storage = vi.mocked(refreshAgentPackages).mock
        .calls[0]![0] as unknown as S3StorageInternals;
      expect(storage.bucket).toBe('instance-bucket');
      expect(log).toHaveBeenCalledWith(
        `[agent package refresh] cache storage from the env file ${file}`,
      );
      // Credentials are never printed.
      for (const call of log.mock.calls) {
        expect(String(call[0])).not.toContain('instance-secret');
      }
    });

    it('skips, naming the env file, when the env file sets no storage', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      // The shell has storage; the instance does not. The shell must not win.
      vi.stubEnv('KICI_STORAGE_TYPE', 's3');
      vi.stubEnv('KICI_STORAGE_BUCKET', 'shell-bucket');
      const file = writeEnvFile(NO_STORAGE_ENV_FILE);

      const ran = await runAgentPackageRefresh({ storageEnv: storageEnvFromEnvFile(file) });

      // fails-when: the shell's KICI_STORAGE_* overrides the instance config.
      expect(ran).toBe(false);
      expect(refreshAgentPackages).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(
        `[agent package refresh] the env file ${file} configures no S3 cache storage ` +
          '— skipping (payloads are served from the cache bucket)',
      );
    });
  });
});
