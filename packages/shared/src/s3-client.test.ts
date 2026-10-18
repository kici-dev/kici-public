import { afterEach, describe, it, expect, vi } from 'vitest';
import { createS3Client } from './s3-client.js';

/**
 * Resolve a value that the SDK may store either as a literal or as an async
 * `Provider<T>` on the client config.
 */
async function resolve<T>(value: T | (() => Promise<T>)): Promise<T> {
  return typeof value === 'function' ? await (value as () => Promise<T>)() : value;
}

describe('createS3Client', () => {
  it('disables default request/response checksums so pre-signed PUTs work on strict S3-compatible stores', async () => {
    // The SDK v3 default (`WHEN_SUPPORTED`) puts an x-amz-checksum-crc32 header in
    // pre-signed PUT URLs that SeaweedFS / MinIO / R2 reject with 400.
    const client = createS3Client({ endpoint: 'http://localhost:8333', forcePathStyle: true });
    await expect(resolve(client.config.requestChecksumCalculation)).resolves.toBe('WHEN_REQUIRED');
    await expect(resolve(client.config.responseChecksumValidation)).resolves.toBe('WHEN_REQUIRED');
  });

  it('passes through region, endpoint, and forcePathStyle', async () => {
    const client = createS3Client({
      region: 'eu-central-1',
      endpoint: 'https://s3.example.com',
      forcePathStyle: true,
    });
    await expect(resolve(client.config.region)).resolves.toBe('eu-central-1');
    await expect(resolve(client.config.forcePathStyle)).resolves.toBe(true);
  });

  describe('credentials', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('uses explicit credentials over the AWS_* variables of the process', async () => {
      vi.stubEnv('AWS_ACCESS_KEY_ID', 'shell-key');
      vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'shell-secret');
      const client = createS3Client({
        region: 'us-east-1',
        credentials: { accessKeyId: 'instance-key', secretAccessKey: 'instance-secret' },
      });
      const creds = await client.config.credentials();
      // fails-when: the credentials option is dropped, so the default chain
      // reads the process AWS_ACCESS_KEY_ID instead.
      expect(creds.accessKeyId).toBe('instance-key');
      expect(creds.secretAccessKey).toBe('instance-secret');
    });

    it('passes the profile through to the client config', () => {
      const client = createS3Client({ region: 'us-east-1', profile: 'kici-cache' });
      // fails-when: the profile option is dropped.
      expect(client.config.profile).toBe('kici-cache');
    });

    it('keeps the default credential chain when no credentials are given', async () => {
      vi.stubEnv('AWS_ACCESS_KEY_ID', 'shell-key');
      vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'shell-secret');
      const client = createS3Client({ region: 'us-east-1' });
      // breaks-if-wrong: a server that relies on the default chain (its own
      // environment, an instance role) must keep resolving it.
      await expect(client.config.credentials()).resolves.toMatchObject({
        accessKeyId: 'shell-key',
      });
    });
  });
});
