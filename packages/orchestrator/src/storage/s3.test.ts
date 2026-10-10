import { describe, it, expect, vi, beforeEach } from 'vitest';
import { S3CacheStorage } from './s3.js';

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
const { PutObjectCommand, CopyObjectCommand, ListObjectsV2Command, HeadObjectCommand } =
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

  describe('getObjectSize()', () => {
    it('returns the HeadObject ContentLength and null when the object is missing', async () => {
      const mockSend = (storage as any).client.send as ReturnType<typeof vi.fn>;
      let call = 0;
      mockSend.mockImplementation(() => {
        call++;
        // 1st HeadObject: object present. 2nd: S3 reports NotFound.
        if (call === 1) return Promise.resolve({ ContentLength: 42 });
        return Promise.reject(Object.assign(new Error('not found'), { name: 'NotFound' }));
      });

      expect(await storage.getObjectSize('present')).toBe(42);
      expect(HeadObjectCommand).toHaveBeenCalledWith({
        Bucket: 'test-bucket',
        Key: 'test-prefix/present',
      });
      expect(await storage.getObjectSize('absent')).toBeNull();
    });

    it('rethrows a non-not-found error rather than reporting a missing object', async () => {
      const mockSend = (storage as any).client.send as ReturnType<typeof vi.fn>;
      mockSend.mockImplementation(() => Promise.reject(new Error('AccessDenied')));
      await expect(storage.getObjectSize('boom')).rejects.toThrow('AccessDenied');
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

  describe('touch() is conditional on the version it read', () => {
    /** Answer the client's sends in order: one entry per S3 call, an Error rejects. */
    function answerInOrder(...responses: unknown[]): void {
      const mockSend = (storage as any).client.send as ReturnType<typeof vi.fn>;
      mockSend.mockReset();
      let call = 0;
      mockSend.mockImplementation(() => {
        const next = responses[call++] ?? {};
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      });
    }

    const headWith = (etag: string | undefined) => ({
      ...(etag && { ETag: etag }),
      Metadata: {
        'created-at': new Date().toISOString(),
        'last-accessed-at': new Date().toISOString(),
      },
    });

    it('pins the self-copy to the HEAD ETag on both the source and the destination', async () => {
      answerInOrder(headWith('"etag-1"'), {});

      await storage.touch('deps/linux-x64/lock.hash');

      expect(CopyObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: 'test-prefix/deps/linux-x64/lock.hash',
          CopySourceIfMatch: '"etag-1"',
          IfMatch: '"etag-1"',
        }),
      );
    });

    it('get() pins its touch-on-read to the HEAD ETag', async () => {
      answerInOrder(
        headWith('"etag-2"'),
        { Body: { transformToByteArray: () => Promise.resolve(Buffer.from('target')) } },
        {},
      );

      expect((await storage.get('some-key'))!.toString()).toBe('target');
      expect(CopyObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({ CopySourceIfMatch: '"etag-2"', IfMatch: '"etag-2"' }),
      );
    });

    it('resolves when the object was replaced since the read (412)', async () => {
      // breaks-if-wrong: the dep-cache hit path awaits this touch, so a refused
      // condition must not surface as a dispatch failure.
      answerInOrder(
        headWith('"etag-3"'),
        Object.assign(new Error('At least one of the pre-conditions you specified did not hold'), {
          name: 'PreconditionFailed',
          $metadata: { httpStatusCode: 412 },
        }),
      );

      await expect(storage.touch('some-key')).resolves.toBeUndefined();
    });

    it('still rethrows any other copy failure', async () => {
      answerInOrder(headWith('"etag-4"'), new Error('AccessDenied'));

      await expect(storage.touch('some-key')).rejects.toThrow('AccessDenied');
    });

    it('resolves when a concurrent write raced the conditional copy (409)', async () => {
      // fails-when: only 412 is read as "replaced" — AWS answers a conditional
      // copy that overlaps a concurrent write with 409, and the dep-cache hit
      // path would fail the dispatch.
      answerInOrder(
        headWith('"etag-5"'),
        Object.assign(new Error('A conflicting conditional operation is in progress'), {
          name: 'ConditionalRequestConflict',
          $metadata: { httpStatusCode: 409 },
        }),
      );

      await expect(storage.touch('some-key')).resolves.toBeUndefined();
      expect(CopyObjectCommand, 'a raced copy is not retried').toHaveBeenCalledTimes(1);
    });

    it('falls back to an unconditional copy on a backend that does not implement it (501)', async () => {
      // fails-when: a 501 is rethrown — every cache hit on such a backend then
      // fails its dispatch, or (via get()) never refreshes its TTL.
      const notImplemented = () =>
        Object.assign(new Error('Copy object not implemented with X-Amz-Copy-Source-If-Match'), {
          name: 'NotImplemented',
          $metadata: { httpStatusCode: 501 },
        });
      answerInOrder(headWith('"etag-6"'), notImplemented(), {}, headWith('"etag-7"'), {});

      await storage.touch('some-key');
      await storage.touch('other-key');

      const copies = vi.mocked(CopyObjectCommand).mock.calls.map((c) => c[0]);
      expect(copies).toHaveLength(3);
      expect(copies[0]).toMatchObject({ CopySourceIfMatch: '"etag-6"', IfMatch: '"etag-6"' });
      // breaks-if-wrong: the retry and every later copy carry no condition,
      // so the metadata refresh still happens on that backend.
      expect(copies[1]).not.toHaveProperty('IfMatch');
      expect(copies[1]).not.toHaveProperty('CopySourceIfMatch');
      expect(copies[2]).toMatchObject({ Key: 'test-prefix/other-key' });
      expect(copies[2]).not.toHaveProperty('IfMatch');
    });

    it('copies unconditionally when the backend reports no ETag', async () => {
      answerInOrder(headWith(undefined), {});

      await storage.touch('some-key');

      const args = vi.mocked(CopyObjectCommand).mock.calls[0][0];
      expect(args).not.toHaveProperty('IfMatch');
      expect(args).not.toHaveProperty('CopySourceIfMatch');
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

  /** The endpoint of the S3 client the developer upload URL was signed with. */
  async function signingEndpoint(endpoints: {
    uploadEndpoint?: string;
    externalEndpoint?: string;
  }): Promise<string | undefined> {
    const storage = new S3CacheStorage({
      bucket: 'kici-cache',
      prefix: 'kici-cache/',
      ttlMs: 60_000,
      region: 'us-east-1',
      endpoint: 'http://seaweedfs:8333',
      forcePathStyle: true,
      ...endpoints,
    });
    await storage.getInternalUploadUrl('test-uploads/x/y.tar.gz.enc');
    // The first arg to getSignedUrl is the S3 client; our mock records the
    // construction config on `__config`.
    const client = vi.mocked(getSignedUrl).mock.calls[0][0] as unknown as {
      __config: { endpoint?: string };
    };
    return client.__config.endpoint;
  }

  it('signs the developer upload URL with the uploadEndpoint client when set', async () => {
    const endpoint = await signingEndpoint({
      uploadEndpoint: 'http://localhost:8333',
      externalEndpoint: 'http://host.docker.internal:8333',
    });
    // fails-when: the developer upload URL is signed against the agent-facing
    // endpoint although KICI_STORAGE_UPLOAD_ENDPOINT is set
    expect(endpoint).toBe('http://localhost:8333');
  });

  it('falls back to the external endpoint client when uploadEndpoint is unset', async () => {
    // breaks-if-wrong: without an upload endpoint the agent-facing one is used
    expect(await signingEndpoint({ externalEndpoint: 'http://host.docker.internal:8333' })).toBe(
      'http://host.docker.internal:8333',
    );
  });

  it('falls back to the internal endpoint client when neither is set', async () => {
    expect(await signingEndpoint({})).toBe('http://seaweedfs:8333');
  });
});
