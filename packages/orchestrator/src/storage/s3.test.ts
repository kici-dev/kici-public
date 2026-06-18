import { describe, it, expect, afterAll, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { S3CacheStorage } from './s3.js';

/**
 * S3 cache storage tests.
 *
 * Unit tests (mocked): Always run, verify getUploadUrl and initMeta behavior.
 * Integration tests: Require real AWS credentials and an S3 bucket.
 * They are skipped unless S3_TEST_BUCKET is set in the environment.
 *
 * Usage:
 *   pnpm test -- --run storage/s3                             # Unit tests only
 *   S3_TEST_BUCKET=my-test-bucket pnpm test -- --run storage/s3  # Unit + integration
 */

const testBucket = process.env.S3_TEST_BUCKET;
const testRegion = process.env.S3_TEST_REGION;

// Unique prefix per test run to avoid collisions
const testPrefix = `kici-test-${randomUUID().slice(0, 8)}/`;

// Track keys for cleanup
const createdKeys: string[] = [];

describe.skipIf(!testBucket)('S3CacheStorage', () => {
  const storage = testBucket
    ? new S3CacheStorage({
        bucket: testBucket,
        prefix: testPrefix,
        ttlMs: 60_000, // 1 minute TTL for tests
        region: testRegion,
      })
    : (null as unknown as S3CacheStorage);

  afterAll(async () => {
    // Clean up all test objects
    if (!testBucket || !storage) return;
    for (const key of createdKeys) {
      try {
        await storage.delete(key);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  // -- put + get roundtrip --

  describe('put() + get()', () => {
    it('stores and retrieves string data', async () => {
      const key = `test-string-${randomUUID().slice(0, 8)}`;
      createdKeys.push(key);

      await storage.put(key, 'hello world');
      const result = await storage.get(key);

      expect(result).not.toBeNull();
      expect(result!.toString()).toBe('hello world');
    });

    it('stores and retrieves Buffer data', async () => {
      const key = `test-buffer-${randomUUID().slice(0, 8)}`;
      createdKeys.push(key);

      const data = Buffer.from([0x00, 0x01, 0x02, 0xff]);
      await storage.put(key, data);
      const result = await storage.get(key);

      expect(result).not.toBeNull();
      expect(Buffer.compare(result!, data)).toBe(0);
    });

    it('returns null for non-existent key', async () => {
      const result = await storage.get('non-existent-key');
      expect(result).toBeNull();
    });
  });

  // -- has() --

  describe('has()', () => {
    it('returns true for existing key', async () => {
      const key = `test-has-${randomUUID().slice(0, 8)}`;
      createdKeys.push(key);

      await storage.put(key, 'data');
      expect(await storage.has(key)).toBe(true);
    });

    it('returns false for missing key', async () => {
      expect(await storage.has('missing-key')).toBe(false);
    });
  });

  // -- delete() --

  describe('delete()', () => {
    it('removes data and returns true for existing key', async () => {
      const key = `test-delete-${randomUUID().slice(0, 8)}`;

      await storage.put(key, 'data');
      const deleted = await storage.delete(key);
      expect(deleted).toBe(true);

      const result = await storage.get(key);
      expect(result).toBeNull();
    });

    it('returns false for non-existent key', async () => {
      const deleted = await storage.delete('never-existed');
      expect(deleted).toBe(false);
    });
  });

  // -- getUrl() --

  describe('getUrl()', () => {
    it('returns a pre-signed URL containing bucket and key', async () => {
      const key = `test-url-${randomUUID().slice(0, 8)}`;
      createdKeys.push(key);

      await storage.put(key, 'data');
      const url = await storage.getUrl(key);

      expect(url).not.toBeNull();
      expect(url).toContain(testBucket);
      expect(url).toContain(testPrefix);
    });

    it('returns null for non-existent key', async () => {
      const url = await storage.getUrl('missing-key');
      expect(url).toBeNull();
    });
  });

  // -- list() + copy() --

  describe('list() + copy()', () => {
    it('lists keys under a sub-prefix and copies bytes to a new key', async () => {
      const base = `list-${randomUUID().slice(0, 8)}`;
      const k1 = `${base}/k1`;
      const k2 = `${base}/k2`;
      const k3 = `other-${randomUUID().slice(0, 8)}/k3`;
      createdKeys.push(k1, k2, k3, `${k1}.committed`);

      await storage.put(k1, 'one');
      await storage.put(k2, 'two');
      await storage.put(k3, 'three');

      const listed = await storage.list(`${base}/`);
      expect(listed.sort()).toEqual([k1, k2].sort());

      await storage.copy(k1, `${k1}.committed`);
      const copied = await storage.get(`${k1}.committed`);
      expect(copied?.toString('utf-8')).toBe('one');
    });
  });

  // -- getMetadata() --

  describe('getMetadata()', () => {
    it('returns createdAt + lastAccessedAt, null when missing', async () => {
      const key = `test-meta-${randomUUID().slice(0, 8)}`;
      createdKeys.push(key);
      expect(await storage.getMetadata(key)).toBeNull();
      await storage.put(key, 'data');
      const meta = await storage.getMetadata(key);
      expect(meta).not.toBeNull();
      expect(typeof meta!.createdAt).toBe('string');
      expect(typeof meta!.lastAccessedAt).toBe('string');
    });
  });

  // -- TTL expiry --

  describe('TTL expiry', () => {
    it('expires items after TTL elapses', async () => {
      const shortTtlStorage = new S3CacheStorage({
        bucket: testBucket!,
        prefix: testPrefix,
        ttlMs: 1, // 1ms TTL
        region: testRegion,
      });

      const key = `test-ttl-${randomUUID().slice(0, 8)}`;
      createdKeys.push(key);

      await shortTtlStorage.put(key, 'data');

      // Wait for TTL to pass
      await new Promise((r) => setTimeout(r, 10));

      const result = await shortTtlStorage.get(key);
      expect(result).toBeNull();
    });
  });
});

// -- Unit tests (mocked S3 client) --

// Mock the AWS SDK presigner module
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://mock-s3.example.com/signed-url'),
}));

// Mock the AWS SDK client module
vi.mock('@aws-sdk/client-s3', async () => {
  const mockSend = vi.fn().mockResolvedValue({});
  return {
    S3Client: vi.fn().mockImplementation(function (config: unknown) {
      // Record the construction config so tests can assert which endpoint a
      // given client (internal / external / upload) was built with.
      return { send: mockSend, __config: config };
    }),
    HeadObjectCommand: vi.fn(),
    GetObjectCommand: vi.fn(),
    PutObjectCommand: vi.fn(),
    DeleteObjectCommand: vi.fn(),
    CopyObjectCommand: vi.fn(),
    ListObjectsV2Command: vi.fn(),
  };
});

// Must re-import after mocking
const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
const { PutObjectCommand, CopyObjectCommand, ListObjectsV2Command } =
  await import('@aws-sdk/client-s3');

describe('S3CacheStorage (unit)', () => {
  let storage: S3CacheStorage;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = new S3CacheStorage({
      bucket: 'test-bucket',
      prefix: 'test-prefix/',
      ttlMs: 3600_000,
      region: 'us-east-1',
    });
  });

  describe('getUploadUrl()', () => {
    it('returns a pre-signed URL', async () => {
      const url = await storage.getUploadUrl('test-key');
      expect(url).toBe('https://mock-s3.example.com/signed-url');
    });

    it('calls getSignedUrl with PutObjectCommand', async () => {
      await storage.getUploadUrl('test-key');
      expect(getSignedUrl).toHaveBeenCalledTimes(1);
      const args = vi.mocked(getSignedUrl).mock.calls[0];
      // Second arg should be a PutObjectCommand instance
      expect(PutObjectCommand).toHaveBeenCalledWith({
        Bucket: 'test-bucket',
        Key: 'test-prefix/test-key',
      });
    });

    it('uses 1800 seconds expiry for uploads', async () => {
      await storage.getUploadUrl('test-key');
      const args = vi.mocked(getSignedUrl).mock.calls[0];
      // Third arg is the options object with expiresIn
      expect(args[2]).toEqual({ expiresIn: 1800 });
    });

    it('includes prefix in the object key', async () => {
      await storage.getUploadUrl('source/abc123.tar.gz');
      expect(PutObjectCommand).toHaveBeenCalledWith({
        Bucket: 'test-bucket',
        Key: 'test-prefix/source/abc123.tar.gz',
      });
    });
  });

  describe('get() touch-on-read resilience', () => {
    it('returns data even when updateMeta (touch) fails', async () => {
      // Access the mocked send function on the internal client
      const mockSend = (storage as any).client.send as ReturnType<typeof vi.fn>;

      const bodyContent = Buffer.from('cached-data');
      let callCount = 0;
      mockSend.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // HeadObjectCommand (readMeta) — return valid metadata
          return Promise.resolve({
            Metadata: {
              'created-at': new Date().toISOString(),
              'last-accessed-at': new Date().toISOString(),
            },
          });
        }
        if (callCount === 2) {
          // GetObjectCommand — return body
          return Promise.resolve({
            Body: { transformToByteArray: () => Promise.resolve(bodyContent) },
          });
        }
        if (callCount === 3) {
          // CopyObjectCommand (updateMeta / touch) — simulate transient failure
          return Promise.reject(new Error('Transient S3 error'));
        }
        return Promise.resolve({});
      });

      const result = await storage.get('some-key');
      expect(result).not.toBeNull();
      expect(result!.toString()).toBe('cached-data');
    });

    it('returns data even when updateMeta throws NotFound (concurrent delete)', async () => {
      const mockSend = (storage as any).client.send as ReturnType<typeof vi.fn>;

      const bodyContent = Buffer.from('cached-data');
      let callCount = 0;
      mockSend.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            Metadata: {
              'created-at': new Date().toISOString(),
              'last-accessed-at': new Date().toISOString(),
            },
          });
        }
        if (callCount === 2) {
          return Promise.resolve({
            Body: { transformToByteArray: () => Promise.resolve(bodyContent) },
          });
        }
        if (callCount === 3) {
          const err = new Error('Not Found');
          (err as any).name = 'NotFound';
          return Promise.reject(err);
        }
        return Promise.resolve({});
      });

      const result = await storage.get('some-key');
      expect(result).not.toBeNull();
      expect(result!.toString()).toBe('cached-data');
    });
  });

  describe('list()', () => {
    it('strips the storage prefix and returns keys newest-first', async () => {
      const mockSend = (storage as any).client.send as ReturnType<typeof vi.fn>;
      const older = new Date(1000);
      const newer = new Date(2000);
      mockSend.mockResolvedValueOnce({
        Contents: [
          { Key: 'test-prefix/a/k1', LastModified: older },
          { Key: 'test-prefix/a/k2', LastModified: newer },
        ],
        IsTruncated: false,
      });
      const listed = await storage.list('a/');
      expect(ListObjectsV2Command).toHaveBeenCalledWith(
        expect.objectContaining({ Bucket: 'test-bucket', Prefix: 'test-prefix/a/' }),
      );
      // Newest first; prefix stripped.
      expect(listed).toEqual(['a/k2', 'a/k1']);
    });
  });

  describe('copy()', () => {
    it('issues a server-side CopyObjectCommand from src to dest', async () => {
      await storage.copy('a/src', 'a/dest');
      expect(CopyObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Bucket: 'test-bucket',
          Key: 'test-prefix/a/dest',
          CopySource: 'test-bucket/test-prefix/a/src',
          MetadataDirective: 'REPLACE',
        }),
      );
    });
  });

  describe('initMeta()', () => {
    it('calls CopyObjectCommand with REPLACE directive and metadata', async () => {
      const beforeCall = new Date().toISOString();
      await storage.initMeta('test-key');

      expect(CopyObjectCommand).toHaveBeenCalledTimes(1);
      const args = vi.mocked(CopyObjectCommand).mock.calls[0][0];
      expect(args).toMatchObject({
        Bucket: 'test-bucket',
        Key: 'test-prefix/test-key',
        CopySource: 'test-bucket/test-prefix/test-key',
        MetadataDirective: 'REPLACE',
      });
      // Verify metadata has timestamps
      expect(args.Metadata).toBeDefined();
      expect(args.Metadata!['created-at']).toBeDefined();
      expect(args.Metadata!['last-accessed-at']).toBeDefined();
      // Both timestamps should be equal (same call to toISOString)
      expect(args.Metadata!['created-at']).toBe(args.Metadata!['last-accessed-at']);
    });
  });
});

describe('getInternalUploadUrl endpoint selection (unit)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('signs the host-CLI upload URL with the uploadEndpoint client when set', async () => {
    const storage = new S3CacheStorage({
      bucket: 'kici-cache',
      prefix: 'kici-cache/',
      ttlMs: 60_000,
      region: 'us-east-1',
      endpoint: 'http://seaweedfs:8333',
      uploadEndpoint: 'http://localhost:8333',
      externalEndpoint: 'http://host.docker.internal:8333',
      forcePathStyle: true,
    });

    await storage.getInternalUploadUrl('test-uploads/x/y.tar.gz.enc');

    // The first arg to getSignedUrl is the S3 client; our mock records the
    // construction config on `__config`. The host-CLI upload must use the
    // uploadEndpoint client, not the orchestrator's internal endpoint client.
    const client = vi.mocked(getSignedUrl).mock.calls[0][0] as unknown as {
      __config: { endpoint?: string };
    };
    expect(client.__config.endpoint).toBe('http://localhost:8333');
  });

  it('falls back to the internal endpoint client when uploadEndpoint is unset', async () => {
    const storage = new S3CacheStorage({
      bucket: 'kici-cache',
      prefix: 'kici-cache/',
      ttlMs: 60_000,
      region: 'us-east-1',
      endpoint: 'http://seaweedfs:8333',
      externalEndpoint: 'http://host.docker.internal:8333',
      forcePathStyle: true,
    });

    await storage.getInternalUploadUrl('test-uploads/x/y.tar.gz.enc');

    const client = vi.mocked(getSignedUrl).mock.calls[0][0] as unknown as {
      __config: { endpoint?: string };
    };
    expect(client.__config.endpoint).toBe('http://seaweedfs:8333');
  });
});
