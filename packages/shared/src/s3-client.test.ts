import { describe, it, expect } from 'vitest';
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
    // The SDK v3 default (`WHEN_SUPPORTED`) embeds an x-amz-checksum-crc32 header
    // in pre-signed PUT URLs that SeaweedFS / MinIO / R2 reject with 400. The
    // client must pin `WHEN_REQUIRED` for the upload/download presign path.
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
});
