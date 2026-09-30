import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { S3CacheStorage } from './s3.js';

/**
 * S3 cache storage against a real bucket.
 *
 * Requires AWS credentials in the environment and an S3 bucket; skipped unless
 * S3_TEST_BUCKET is set. It lives apart from the mocked suite in `s3.test.ts`
 * because that file replaces the SDK module for the whole file, which would
 * route these cases through the mock too.
 *
 * Usage:
 *   S3_TEST_BUCKET=my-test-bucket S3_TEST_REGION=eu-central-1 \
 *     pnpm exec vitest run src/storage/s3.bucket.test.ts
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

  // -- touch against a concurrent rewrite --
  //
  // A touch reads the object's metadata, then self-copies the object to write
  // the refreshed timestamp. The stale ETag below is what a touch holds when a
  // `put()` of the same key lands between its read and its copy: the race that
  // put a rebuilt dependency pointer back onto a deleted tarball.

  describe('touch against a concurrent rewrite', () => {
    async function staleHeadAfterRewrite(key: string) {
      await storage.put(key, 'old-target');
      const stale = await (storage as any).readHead(key);
      expect(stale?.etag, 'S3 reports an ETag the touch can pin').toBeTruthy();
      await storage.put(key, 'new-target');
      const fresh = await storage.getMetadata(key);
      expect(fresh!.createdAt).not.toBe(stale.meta.createdAt);
      return { stale, fresh: fresh! };
    }

    it('a touch that read the replaced version leaves the newer object alone', async () => {
      const key = `test-touch-race-${randomUUID().slice(0, 8)}`;
      createdKeys.push(key);
      const { stale, fresh } = await staleHeadAfterRewrite(key);

      // fails-when: the self-copy is unconditional — S3 applies it and the
      // replaced version's metadata lands on the newer object.
      const applied = await (storage as any).updateMeta(
        key,
        { ...stale.meta, lastAccessedAt: new Date().toISOString() },
        stale.etag,
      );
      expect(applied).toBe(false);
      expect((await storage.getMetadata(key))!.createdAt).toBe(fresh.createdAt);
      expect((await storage.get(key))!.toString()).toBe('new-target');
    });

    it('the same stale self-copy without the condition overwrites the newer object', async () => {
      // The hazard the condition exists for, driven through its input: the
      // identical call with no ETag is applied, and the stale metadata wins.
      const key = `test-touch-uncond-${randomUUID().slice(0, 8)}`;
      createdKeys.push(key);
      const { stale } = await staleHeadAfterRewrite(key);

      const applied = await (storage as any).updateMeta(key, stale.meta, undefined);
      expect(applied).toBe(true);
      expect((await storage.getMetadata(key))!.createdAt).toBe(stale.meta.createdAt);
    });

    it('a touch of an unchanged object refreshes last-accessed-at and keeps the body', async () => {
      // breaks-if-wrong: the conditional copy must still apply when nothing
      // raced it, or no cache entry's TTL is ever refreshed.
      const key = `test-touch-plain-${randomUUID().slice(0, 8)}`;
      createdKeys.push(key);
      await storage.put(key, 'body');
      const before = await storage.getMetadata(key);
      await new Promise((r) => setTimeout(r, 20));

      await storage.touch(key);

      const after = await storage.getMetadata(key);
      expect(after!.createdAt).toBe(before!.createdAt);
      expect(after!.lastAccessedAt > before!.lastAccessedAt).toBe(true);
      expect((await storage.get(key))!.toString()).toBe('body');
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
