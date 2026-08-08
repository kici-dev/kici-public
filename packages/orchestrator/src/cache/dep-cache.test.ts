import { describe, it, expect, beforeEach } from 'vitest';
import type { CacheStorage } from '../storage/types.js';
import { DepCache } from './dep-cache.js';

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
}

describe('DepCache', () => {
  let storage: InMemoryCacheStorage;
  let cache: DepCache;

  beforeEach(() => {
    storage = new InMemoryCacheStorage();
    cache = new DepCache({ storage });
  });

  describe('getUrlAndHash', () => {
    it('returns null on cache miss', async () => {
      const result = await cache.getUrlAndHash('nonexistent', 'linux', 'x64');
      expect(result).toBeNull();
    });

    it('returns url without hash for entries without companion hash file', async () => {
      // Store tarball but no hash file (simulates old cache entries)
      await storage.put('deps/linux-x64/abc123.tar.gz', Buffer.from('tarball-data'));

      const result = await cache.getUrlAndHash('abc123', 'linux', 'x64');
      expect(result).not.toBeNull();
      expect(result!.url).toContain('deps/linux-x64/abc123.tar.gz');
      expect(result!.hash).toBeUndefined();
    });

    it('returns url and hash when companion hash file exists', async () => {
      // Store tarball and companion hash file
      await storage.put('deps/linux-x64/abc123.tar.gz', Buffer.from('tarball-data'));
      await storage.put('deps/linux-x64/abc123.hash', 'sha256-content-hash');

      const result = await cache.getUrlAndHash('abc123', 'linux', 'x64');
      expect(result).not.toBeNull();
      expect(result!.url).toContain('deps/linux-x64/abc123.tar.gz');
      expect(result!.hash).toBe('sha256-content-hash');
    });

    it('uses platform-specific keys', async () => {
      await storage.put('deps/darwin-arm64/lock1.tar.gz', Buffer.from('data'));
      await storage.put('deps/darwin-arm64/lock1.hash', 'hash-arm64');

      // Should find darwin/arm64 entry
      const result = await cache.getUrlAndHash('lock1', 'darwin', 'arm64');
      expect(result).not.toBeNull();
      expect(result!.hash).toBe('hash-arm64');

      // Should not find linux/x64 entry
      const miss = await cache.getUrlAndHash('lock1', 'linux', 'x64');
      expect(miss).toBeNull();
    });
  });

  describe('cluster_settings overrides', () => {
    function makeClusterSettings(values: {
      cache_max_tarball_bytes?: number;
      cache_ttl_days?: number;
    }) {
      return {
        getNumber: async (col: string, fallback: number) =>
          (values as Record<string, number | undefined>)[col] ?? fallback,
      } as unknown as import('../cluster/cluster-settings-reader.js').ClusterSettingsReader;
    }

    it('enforces cache_max_tarball_bytes live from cluster_settings (override wins)', async () => {
      const overridden = new DepCache({
        storage,
        maxTarballBytes: 500_000_000,
        clusterSettings: makeClusterSettings({ cache_max_tarball_bytes: 10 }),
      });
      // 11 bytes > 10-byte override → rejected even though the ctor cap is 500MB.
      await expect(
        overridden.store('lock1', 'linux', 'x64', Buffer.from('12345678901')),
      ).rejects.toThrow(/exceeds max size/);
    });

    it('falls back to the constructor cap when cache_max_tarball_bytes is null', async () => {
      const fallbackCache = new DepCache({
        storage,
        maxTarballBytes: 100,
        clusterSettings: makeClusterSettings({}), // reader returns the fallback
      });
      // 11 bytes < 100-byte fallback → stored fine.
      await expect(
        fallbackCache.store('lock1', 'linux', 'x64', Buffer.from('12345678901')),
      ).resolves.toBeUndefined();
    });

    it('passes a live cache_ttl_days TTL override to storage reads', async () => {
      const calls: (number | undefined)[] = [];
      const recordingStorage = {
        ...storage,
        has: async (_k: string, ttlMsOverride?: number) => {
          calls.push(ttlMsOverride);
          return true;
        },
        getUrl: async (k: string, ttlMsOverride?: number) => {
          calls.push(ttlMsOverride);
          return `https://mock/${k}`;
        },
        touch: async () => {},
      } as unknown as CacheStorage;
      const ttlCache = new DepCache({
        storage: recordingStorage,
        cacheTtlDaysFallback: 30,
        clusterSettings: makeClusterSettings({ cache_ttl_days: 7 }),
      });
      await ttlCache.has('lock1', 'linux', 'x64');
      await ttlCache.getUrl('lock1', 'linux', 'x64');
      // 7 days → ms override on every read/expiry call.
      const sevenDaysMs = 7 * 86_400_000;
      expect(calls).toEqual([sevenDaysMs, sevenDaysMs]);
    });
  });
});
