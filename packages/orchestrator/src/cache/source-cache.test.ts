import { describe, it, expect, beforeEach } from 'vitest';
import type { CacheStorage } from '../storage/types.js';
import { SourceCache, sourceTarballKey, sourcePointerKey } from './source-cache.js';

/**
 * In-memory CacheStorage mock for unit testing.
 */
class InMemoryCacheStorage implements CacheStorage {
  private store = new Map<string, { data: Buffer; createdAt: string; lastAccessedAt: string }>();

  async put(key: string, data: Buffer | string): Promise<void> {
    const now = new Date().toISOString();
    const buf = typeof data === 'string' ? Buffer.from(data) : data;
    this.store.set(key, { data: buf, createdAt: now, lastAccessedAt: now });
  }

  async get(key: string): Promise<Buffer | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    entry.lastAccessedAt = new Date().toISOString();
    return entry.data;
  }

  async has(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  async touch(key: string): Promise<void> {
    const entry = this.store.get(key);
    if (entry) entry.lastAccessedAt = new Date().toISOString();
  }

  async getUrl(key: string): Promise<string | null> {
    if (!this.store.has(key)) return null;
    return `https://mock-s3.example.com/${key}`;
  }

  async getUploadUrl(key: string): Promise<string> {
    return `https://mock-s3.example.com/upload/${key}`;
  }

  async getInternalUploadUrl(key: string): Promise<string> {
    return `https://mock-s3.example.com/internal-upload/${key}`;
  }

  async initMeta(_key: string): Promise<void> {
    // no-op for testing
  }

  /** Pure stat: byte size of the stored blob, null when the key is absent. */
  async getObjectSize(key: string): Promise<number | null> {
    return this.store.get(key)?.data.length ?? null;
  }

  presignedGetTtlSeconds(): number {
    return 3600;
  }

  async list(subPrefix: string): Promise<string[]> {
    return [...this.store.keys()].filter((k) => k.startsWith(subPrefix));
  }

  async copy(srcKey: string, destKey: string): Promise<void> {
    const entry = this.store.get(srcKey);
    if (!entry) throw new Error(`copy: source key not found: ${srcKey}`);
    this.store.set(destKey, { ...entry });
  }

  async getMetadata(key: string): Promise<{ createdAt: string; lastAccessedAt: string } | null> {
    const entry = this.store.get(key);
    return entry ? { createdAt: entry.createdAt, lastAccessedAt: entry.lastAccessedAt } : null;
  }
}

describe('SourceCache', () => {
  let storage: InMemoryCacheStorage;
  let cache: SourceCache;
  const ORG_A = 'org-a';
  const ORG_B = 'org-b';
  const CONTENT = 'contenthash-abc';
  const tar = Buffer.from('tarball bytes');
  const digest = SourceCache.computeDigest(tar);

  beforeEach(() => {
    storage = new InMemoryCacheStorage();
    cache = new SourceCache({ storage });
  });

  describe('key layout', () => {
    it('scopes both halves by org under the v2 prefix', () => {
      expect(sourceTarballKey(ORG_A, digest)).toBe(`source/v2/${ORG_A}/${digest}.tar.gz`);
      expect(sourcePointerKey(ORG_A, CONTENT)).toBe(`source/v2/${ORG_A}/${CONTENT}.hash`);
    });

    it('names the tarball by its own bytes, not by the contentHash', () => {
      // Content addressing is what makes a mismatched pair unrepresentable: the
      // bytes at a key can never change after a URL is signed for it.
      expect(sourceTarballKey(ORG_A, digest)).not.toContain(CONTENT);
    });
  });

  describe('org scoping', () => {
    it('does not serve one org a tarball another org stored', async () => {
      // Two repos scaffolded from the same `kici init` template produce the same
      // contentHash. Under the old un-scoped key they shared one object, so
      // whichever built first won for the life of that object.
      await cache.store(ORG_A, CONTENT, tar);
      expect(await cache.has(ORG_A, CONTENT)).toBe(true);
      expect(await cache.has(ORG_B, CONTENT)).toBe(false);
      expect(await cache.getUrl(ORG_B, CONTENT)).toBeNull();
    });

    it('resolves one contentHash to two different keys for two orgs', async () => {
      await cache.store(ORG_A, CONTENT, tar);
      await cache.store(ORG_B, CONTENT, Buffer.from('different bytes'));
      const a = await cache.getUrlAndDigest(ORG_A, CONTENT);
      const b = await cache.getUrlAndDigest(ORG_B, CONTENT);
      expect(a!.digest).not.toBe(b!.digest);
      expect(a!.url).not.toBe(b!.url);
    });

    it('shares a warm entry inside one org', async () => {
      // Byte-identical trees in one org SHOULD share — that is why org, not
      // repo, is the scoping segment.
      await cache.store(ORG_A, CONTENT, tar);
      await cache.store(ORG_A, 'other-content', tar);
      expect(await cache.getUrlAndDigest(ORG_A, 'other-content')).toMatchObject({ digest });
    });
  });

  describe('the pointer indirection', () => {
    it('returns null on a miss', async () => {
      expect(await cache.getUrlAndDigest(ORG_A, 'nope')).toBeNull();
      expect(await cache.has(ORG_A, 'nope')).toBe(false);
      expect(await cache.get(ORG_A, 'nope')).toBeNull();
    });

    it('treats a tarball with no pointer as a miss', async () => {
      await storage.put(sourceTarballKey(ORG_A, digest), tar);
      expect(await cache.has(ORG_A, CONTENT)).toBe(false);
    });

    it('treats a dangling pointer as a miss, so the caller rebuilds', async () => {
      // The two halves expire independently; serving a URL that 404s on the
      // agent is worse than reporting a miss.
      await cache.store(ORG_A, CONTENT, tar);
      await storage.delete(sourceTarballKey(ORG_A, digest));
      expect(await cache.has(ORG_A, CONTENT)).toBe(false);
      expect(await cache.getUrlAndDigest(ORG_A, CONTENT)).toBeNull();
    });

    it('returns a url and the digest that names the very object it points at', async () => {
      await cache.store(ORG_A, CONTENT, tar);
      const hit = await cache.getUrlAndDigest(ORG_A, CONTENT);
      expect(hit!.digest).toBe(digest);
      expect(hit!.url).toContain(sourceTarballKey(ORG_A, digest));
    });

    it('publishPointer makes an already-uploaded tarball discoverable', async () => {
      await storage.put(sourceTarballKey(ORG_A, digest), tar);
      expect(await cache.has(ORG_A, CONTENT)).toBe(false);
      await cache.publishPointer(ORG_A, CONTENT, digest);
      expect(await cache.has(ORG_A, CONTENT)).toBe(true);
    });

    it('signs an upload URL for the tarball own digest', async () => {
      expect(await cache.getUploadUrl(ORG_A, digest)).toContain(sourceTarballKey(ORG_A, digest));
    });
  });

  describe('remove', () => {
    it('drops both halves', async () => {
      await cache.store(ORG_A, CONTENT, tar);
      expect(await cache.remove(ORG_A, CONTENT)).toBe(true);
      expect(await storage.has(sourcePointerKey(ORG_A, CONTENT))).toBe(false);
      expect(await storage.has(sourceTarballKey(ORG_A, digest))).toBe(false);
    });

    it('reports not-found when no pointer exists', async () => {
      expect(await cache.remove(ORG_A, 'nope')).toBe(false);
    });
  });
});
