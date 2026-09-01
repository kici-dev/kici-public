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

    it('treats a tarball with no pointer as a miss', async () => {
      // A deliberate behavior change. The old layout returned a URL with an
      // undefined hash here, so the agent downloaded the tarball with NO
      // integrity check at all. Under content-addressing an object nothing
      // points at is unreachable by design: report a miss and rebuild rather
      // than hand out bytes we cannot verify.
      await storage.put('deps/linux-x64/deadbeef.tar.gz', Buffer.from('tarball-data'));

      expect(await cache.getUrlAndHash('abc123', 'linux', 'x64')).toBeNull();
    });

    it('resolves the pointer and returns a url addressed by the content hash', async () => {
      await cache.store('abc123', 'linux', 'x64', Buffer.from('tarball-data'));

      const result = await cache.getUrlAndHash('abc123', 'linux', 'x64');
      expect(result).not.toBeNull();
      expect(result!.hash).toBeDefined();
      expect(result!.url).toContain(`deps/linux-x64/${result!.hash}.tar.gz`);
    });

    it('treats a pointer whose tarball is gone as a miss, not a hit', async () => {
      // The two halves expire independently, so a live pointer can outlast its
      // tarball. Reporting a hit there dispatches a URL that 404s on the agent.
      await cache.store('abc123', 'linux', 'x64', Buffer.from('tarball-data'));
      const hit = await cache.getUrlAndHash('abc123', 'linux', 'x64');
      await storage.delete(`deps/linux-x64/${hit!.hash}.tar.gz`);

      expect(await cache.getUrlAndHash('abc123', 'linux', 'x64')).toBeNull();
      expect(await cache.has('abc123', 'linux', 'x64')).toBe(false);
    });

    it('uses platform-specific keys', async () => {
      await cache.store('lock1', 'darwin', 'arm64', Buffer.from('data'));

      const result = await cache.getUrlAndHash('lock1', 'darwin', 'arm64');
      expect(result).not.toBeNull();
      expect(result!.url).toContain('deps/darwin-arm64/');

      // The same lockfile on another platform is a separate entry.
      expect(await cache.getUrlAndHash('lock1', 'linux', 'x64')).toBeNull();
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
        // The pointer read is a storage read too, so it must carry the override
        // as well — it is now the FIRST read on both paths.
        get: async (_k: string, ttlMsOverride?: number) => {
          calls.push(ttlMsOverride);
          return Buffer.from('deadbeefhash');
        },
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
      // 7 days → ms override on every read/expiry call. Each path now makes two
      // reads: resolve the pointer (`get`), then the tarball (`has` / `getUrl`).
      const sevenDaysMs = 7 * 86_400_000;
      expect(calls).toEqual([sevenDaysMs, sevenDaysMs, sevenDaysMs, sevenDaysMs]);
    });
  });
});

/**
 * Two builds that share a lockfile, platform and arch also share the dep-cache
 * keys. The tarball and its expected hash used to be two independently-written
 * objects under lockfile-derived names, so concurrent builders could leave the
 * `.tar.gz` from one and the `.hash` from the other — a mismatched pair the
 * reader could not detect until the agent failed verification, durably, on
 * every retry.
 *
 * Observed in production of the `cache-cross-platform` E2E category: one webhook
 * triggers two workflows whose build jobs both run on linux-x64, and the reader
 * downloaded builder A's tarball while holding builder B's hash.
 *
 * Content-addressing the tarball makes that state unrepresentable — the hash IS
 * the key, so any pair a reader can observe is self-consistent.
 */
describe('DepCache — concurrent writers cannot produce a mismatched pair', () => {
  let storage: InMemoryCacheStorage;
  let cache: DepCache;

  beforeEach(() => {
    storage = new InMemoryCacheStorage();
    cache = new DepCache({ storage });
  });

  /** Two builders, same lockfile/platform/arch, byte-different tarballs. */
  const LOCK = 'sharedlock';
  const A = Buffer.from('tarball produced by builder A');
  const B = Buffer.from('tarball produced by builder B — different bytes');

  it('returns a url whose bytes hash to the hash it returns, after interleaved writes', async () => {
    // Interleaved worst case: A stores, B stores, and the reader looks up in
    // between and after. Every observation must be self-consistent.
    await cache.store(LOCK, 'linux', 'x64', A);
    const afterA = await cache.getUrlAndHash(LOCK, 'linux', 'x64');
    await cache.store(LOCK, 'linux', 'x64', B);
    const afterB = await cache.getUrlAndHash(LOCK, 'linux', 'x64');

    for (const observed of [afterA, afterB]) {
      expect(observed).not.toBeNull();
      // The url must address an object whose content hashes to `hash`.
      const key = observed!.url.replace('https://mock-s3.example.com/', '');
      const bytes = await storage.get(key);
      expect(bytes).not.toBeNull();
      const { createHash } = await import('node:crypto');
      const actual = createHash('sha256').update(bytes!).digest('hex');
      expect(actual).toBe(observed!.hash);
    }
  });

  it("keeps the earlier tarball readable after a second builder's write", async () => {
    // A reader that resolved the pointer before B landed still has a valid
    // object to fetch — content-addressed keys are never overwritten in place.
    await cache.store(LOCK, 'linux', 'x64', A);
    const early = await cache.getUrlAndHash(LOCK, 'linux', 'x64');
    await cache.store(LOCK, 'linux', 'x64', B);

    const key = early!.url.replace('https://mock-s3.example.com/', '');
    const bytes = await storage.get(key);
    expect(bytes?.toString()).toBe(A.toString());
  });

  it('addresses the tarball by its content hash, not by the lockfile hash', async () => {
    await cache.store(LOCK, 'linux', 'x64', A);
    const result = await cache.getUrlAndHash(LOCK, 'linux', 'x64');
    expect(result!.url).toContain(result!.hash);
    expect(result!.url).not.toContain(`${LOCK}.tar.gz`);
  });
});
