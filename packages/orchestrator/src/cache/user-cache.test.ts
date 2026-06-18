import { describe, it, expect, beforeEach, vi } from 'vitest';

// Replace the shared logger with a stable spy so the eviction tests can assert
// the structured `logger.info('user-cache eviction ...')` line is emitted (the
// Loki-queryable observability surface). vi.hoisted is required because
// vi.mock() is hoisted above all imports, so the captured logger must exist
// before the mock factory runs.
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@kici-dev/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kici-dev/shared')>();
  return {
    ...actual,
    createLogger: () => mockLogger,
  };
});

import { UserCache } from './user-cache.js';
import type { CacheStorage } from '../storage/types.js';

/**
 * In-memory CacheStorage stub implementing the full interface (incl. list/copy).
 *
 * `getUrl` returns `mem://<key>` for present keys; `getUploadUrl` returns
 * `put://<key>`. Each stored object carries a monotonically-increasing
 * `created` counter so `list()` can return newest-first deterministically
 * without relying on wall-clock resolution.
 *
 * TTL: the stub honors a constructor `ttlMs` against a controllable `clock`
 * (advanced by tests via `advance()`), recording each object's logical
 * creation tick. `getUrl`/`has`/`get` lazily delete and report a miss once
 * `clock - createdTick > ttlMs`, mirroring the real S3/filesystem backends'
 * lazy expiry-on-access (touch refreshes the tick like `lastAccessedAt`).
 */
class FakeStorage implements CacheStorage {
  private readonly data = new Map<string, Buffer>();
  private readonly created = new Map<string, number>();
  /** Logical creation/last-access tick per key, used for TTL expiry. */
  private readonly createdTick = new Map<string, number>();
  /** Immutable per-key creation order (NOT bumped on touch). Drives list() + createdAt. */
  private readonly createdSeq = new Map<string, number>();
  /** Per-key last-access order, bumped on touch. Drives getMetadata.lastAccessedAt. */
  private readonly lastAccessSeq = new Map<string, number>();
  private seq = 0;
  /** Controllable logical clock (ms). Tests advance it past `ttlMs`. */
  private clock = 0;
  private readonly ttlMs: number;

  constructor(opts: { ttlMs?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? Number.POSITIVE_INFINITY;
  }

  /** Advance the logical clock so entries can age past their TTL. */
  advance(ms: number): void {
    this.clock += ms;
  }

  /** True when the key is present but aged past its TTL. */
  private isExpired(key: string): boolean {
    const tick = this.createdTick.get(key);
    if (tick === undefined) return false;
    return this.clock - tick > this.ttlMs;
  }

  /** Lazily delete an expired key; returns true if the key is gone/missing. */
  private evictIfExpired(key: string): boolean {
    if (!this.data.has(key)) return true;
    if (this.isExpired(key)) {
      this.data.delete(key);
      this.created.delete(key);
      this.createdTick.delete(key);
      this.createdSeq.delete(key);
      this.lastAccessSeq.delete(key);
      return true;
    }
    return false;
  }

  /** Record a create/overwrite: set creation order once, bump access order, reset TTL tick. */
  private record(key: string): void {
    if (!this.createdSeq.has(key)) this.createdSeq.set(key, this.seq++);
    this.lastAccessSeq.set(key, this.seq++);
    this.created.set(key, this.createdSeq.get(key)!); // keep list() keyed on creation order
    this.createdTick.set(key, this.clock);
  }

  /** Record an access (touch): bump access order + reset TTL tick; creation order is untouched. */
  private noteAccess(key: string): void {
    this.lastAccessSeq.set(key, this.seq++);
    this.createdTick.set(key, this.clock);
  }

  /** Simulate the agent's presigned PUT landing a temp object. */
  simulateUpload(key: string, body: Buffer): void {
    this.data.set(key, body);
    this.record(key);
  }

  async put(key: string, data: Buffer | string): Promise<void> {
    this.data.set(key, typeof data === 'string' ? Buffer.from(data) : data);
    this.record(key);
  }

  async get(key: string): Promise<Buffer | null> {
    if (this.evictIfExpired(key)) return this.data.get(key) ?? null;
    return this.data.get(key) ?? null;
  }

  async has(key: string): Promise<boolean> {
    if (this.evictIfExpired(key)) return false;
    return this.data.has(key);
  }

  async delete(key: string): Promise<boolean> {
    const existed = this.data.delete(key);
    this.created.delete(key);
    this.createdTick.delete(key);
    this.createdSeq.delete(key);
    this.lastAccessSeq.delete(key);
    return existed;
  }

  async touch(key: string): Promise<void> {
    // Bump access recency (and reset TTL) without changing creation order.
    if (this.data.has(key)) this.noteAccess(key);
  }

  async getUrl(key: string): Promise<string | null> {
    if (this.evictIfExpired(key)) return null;
    return this.data.has(key) ? `mem://${key}` : null;
  }

  async getUploadUrl(key: string): Promise<string> {
    return `put://${key}`;
  }

  async getInternalUploadUrl(key: string): Promise<string> {
    return `put://${key}`;
  }

  async initMeta(key: string): Promise<void> {
    // No-op for the stub: presence in `data` is the metadata.
    if (!this.data.has(key)) this.data.set(key, Buffer.alloc(0));
    this.record(key);
  }

  async list(subPrefix: string): Promise<string[]> {
    return [...this.data.keys()]
      .filter((k) => k.startsWith(subPrefix))
      .sort((a, b) => (this.created.get(b) ?? 0) - (this.created.get(a) ?? 0));
  }

  async copy(srcKey: string, destKey: string): Promise<void> {
    const body = this.data.get(srcKey);
    if (body === undefined) throw new Error(`copy: missing source ${srcKey}`);
    this.data.set(destKey, body);
    this.record(destKey);
  }

  async getMetadata(key: string): Promise<import('../storage/types.js').CacheMetadata | null> {
    if (!this.data.has(key)) return null;
    return {
      createdAt: new Date(this.createdSeq.get(key) ?? 0).toISOString(),
      lastAccessedAt: new Date(this.lastAccessSeq.get(key) ?? 0).toISOString(),
    };
  }
}

describe('UserCache', () => {
  let storage: FakeStorage;
  let cache: UserCache;
  const org = 'org-1';
  const repo = 'owner/repo';

  beforeEach(() => {
    mockLogger.info.mockClear();
    storage = new FakeStorage();
    cache = new UserCache({ storage, quotaBytes: 1_000_000, ttlMs: 86_400_000 });
  });

  it('exact-key restore hits after a save (shared scope)', async () => {
    await cache.commitSave({ org, repo, scope: 'shared', key: 'k1', tarHash: 'h', sizeBytes: 10 });
    const r = await cache.restore({ org, repo, scope: 'shared', key: 'k1' });
    expect(r.hit).toBe(true);
    expect(r.matchedKey).toBe('k1');
    expect(r.downloadUrl).toBeDefined();
    expect(r.tarHash).toBe('h');
  });

  it('restoreKeys prefix fallback returns the newest matching entry', async () => {
    await cache.commitSave({
      org,
      repo,
      scope: 'shared',
      key: 'node-v1-aaa',
      tarHash: 'h',
      sizeBytes: 10,
    });
    await cache.commitSave({
      org,
      repo,
      scope: 'shared',
      key: 'node-v1-bbb',
      tarHash: 'h',
      sizeBytes: 10,
    });
    const r = await cache.restore({
      org,
      repo,
      scope: 'shared',
      key: 'node-v1-MISS',
      restoreKeys: ['node-v1-', 'node-'],
    });
    expect(r.hit).toBe(true);
    expect(r.matchedKey).toBe('node-v1-bbb'); // newest under the prefix
  });

  it('immutable save: second save under an exact key is a no-op (skip)', async () => {
    const first = await cache.beginSave({ org, repo, scope: 'shared', key: 'k1' });
    expect(first.skip).toBe(false);
    await cache.commitSave({ org, repo, scope: 'shared', key: 'k1', tarHash: 'h', sizeBytes: 10 });
    const second = await cache.beginSave({ org, repo, scope: 'shared', key: 'k1' });
    expect(second.skip).toBe(true);
    expect(second.uploadUrl).toBeUndefined();
  });

  it('atomic write: a presigned upload lands in a temp key; commit copies to final + removes temp', async () => {
    const begin = await cache.beginSave({ org, repo, scope: 'shared', key: 'k1' });
    expect(begin.uploadUrl).toContain('.tmp-'); // temp key, not the final key
    // simulate the agent PUT landing the temp object:
    storage.simulateUpload(begin.tempKey!, Buffer.from('TARDATA'));
    await cache.commitSave({
      org,
      repo,
      scope: 'shared',
      key: 'k1',
      tarHash: 'h',
      sizeBytes: 7,
      tempKey: begin.tempKey,
    });
    // final exists, temp gone:
    const r = await cache.restore({ org, repo, scope: 'shared', key: 'k1' });
    expect(r.hit).toBe(true);
    expect(await storage.has(begin.tempKey!)).toBe(false);
  });

  it('a dot-only repo id (e.g. ".") produces no collapsible /./ key segment', async () => {
    // The internal provider's repo id is ".". A bare "." segment is collapsed
    // by HTTP/S3 path canonicalization (a/./b -> a/b), which both corrupts the
    // namespace and breaks a pre-signed-URL SigV4 signature. seg() must rewrite
    // an all-dots segment so the key stays canonical and round-trips.
    const dotRef = { org, repo: '.', scope: 'shared' as const };
    const begin = await cache.beginSave({ ...dotRef, key: 'dotkey' });
    expect(begin.tempKey).toBeDefined();
    expect(begin.tempKey).not.toMatch(/\/\.\//); // no bare "." segment
    expect(begin.tempKey).not.toMatch(/\/\.\.\//); // no bare ".." segment
    storage.simulateUpload(begin.tempKey!, Buffer.from('TARDATA'));
    await cache.commitSave({
      ...dotRef,
      key: 'dotkey',
      tarHash: 'h',
      sizeBytes: 7,
      tempKey: begin.tempKey,
    });
    const r = await cache.restore({ ...dotRef, key: 'dotkey' });
    expect(r.hit).toBe(true);
    expect(r.matchedKey).toBe('dotkey');
  });

  it('org isolation: org-2 cannot read org-1 entries', async () => {
    await cache.commitSave({
      org: 'org-1',
      repo,
      scope: 'shared',
      key: 'k1',
      tarHash: 'h',
      sizeBytes: 10,
    });
    const r = await cache.restore({ org: 'org-2', repo, scope: 'shared', key: 'k1' });
    expect(r.hit).toBe(false);
  });

  it('repo isolation: a different repo in the same org cannot read the entry', async () => {
    await cache.commitSave({ org, repo, scope: 'shared', key: 'k1', tarHash: 'h', sizeBytes: 10 });
    const r = await cache.restore({ org, repo: 'owner/other', scope: 'shared', key: 'k1' });
    expect(r.hit).toBe(false);
  });

  it('ref-scope write isolation: an isolated-scope save never lands in shared, but reads shared as fallback', async () => {
    // shared base entry exists:
    await cache.commitSave({
      org,
      repo,
      scope: 'shared',
      key: 'base',
      tarHash: 'h',
      sizeBytes: 10,
      runId: 'r0',
    });
    // isolated (fork PR) restore can read the shared base:
    const fallback = await cache.restore({
      org,
      repo,
      scope: 'isolated',
      key: 'MISS',
      restoreKeys: ['base'],
      runId: 'r1',
    });
    expect(fallback.hit).toBe(true);
    // isolated save lands in the run-scoped isolated namespace, NOT shared:
    await cache.commitSave({
      org,
      repo,
      scope: 'isolated',
      key: 'forkkey',
      tarHash: 'h',
      sizeBytes: 10,
      runId: 'r1',
    });
    const sharedView = await cache.restore({ org, repo, scope: 'shared', key: 'forkkey' });
    expect(sharedView.hit).toBe(false); // shared scope cannot see the isolated write
    const isolatedView = await cache.restore({
      org,
      repo,
      scope: 'isolated',
      key: 'forkkey',
      runId: 'r1',
    });
    expect(isolatedView.hit).toBe(true);
  });

  it('ref-scope read isolation: one isolated run cannot read another run isolated write', async () => {
    await cache.commitSave({
      org,
      repo,
      scope: 'isolated',
      key: 'secret',
      tarHash: 'h',
      sizeBytes: 10,
      runId: 'run-A',
    });
    const otherRun = await cache.restore({
      org,
      repo,
      scope: 'isolated',
      key: 'secret',
      runId: 'run-B',
    });
    expect(otherRun.hit).toBe(false);
  });

  it('isolated scope requires a runId', async () => {
    await expect(cache.restore({ org, repo, scope: 'isolated', key: 'k' })).rejects.toThrow(
      /runId/,
    );
    await expect(cache.beginSave({ org, repo, scope: 'isolated', key: 'k' })).rejects.toThrow(
      /runId/,
    );
  });

  it('quota eviction: saving past the per-org quota evicts oldest entries and logs', async () => {
    cache = new UserCache({ storage, quotaBytes: 25, ttlMs: 86_400_000 });
    mockLogger.info.mockClear();
    await cache.commitSave({ org, repo, scope: 'shared', key: 'a', tarHash: 'h', sizeBytes: 10 });
    await cache.commitSave({ org, repo, scope: 'shared', key: 'b', tarHash: 'h', sizeBytes: 10 });
    await cache.commitSave({ org, repo, scope: 'shared', key: 'c', tarHash: 'h', sizeBytes: 10 }); // total 30 > 25
    // oldest (a) evicted:
    expect((await cache.restore({ org, repo, scope: 'shared', key: 'a' })).hit).toBe(false);
    expect((await cache.restore({ org, repo, scope: 'shared', key: 'c' })).hit).toBe(true);
    // The eviction is surfaced as a structured, Loki-queryable log line with
    // the org, evicted key, and freed bytes.
    const evictionLogs = mockLogger.info.mock.calls.filter(
      ([msg]) => msg === 'user-cache eviction (org over quota)',
    );
    expect(evictionLogs.length).toBeGreaterThanOrEqual(1);
    const [, fields] = evictionLogs[0] as [string, Record<string, unknown>];
    expect(fields).toMatchObject({ org, freedBytes: 10 });
    expect(typeof fields.key).toBe('string');
  });

  it('LRU eviction: a restored (recently-used) entry survives over an older-created but unused one', async () => {
    cache = new UserCache({ storage, quotaBytes: 25, ttlMs: 86_400_000 });
    mockLogger.info.mockClear();
    await cache.commitSave({ org, repo, scope: 'shared', key: 'A', tarHash: 'h', sizeBytes: 10 });
    await cache.commitSave({ org, repo, scope: 'shared', key: 'B', tarHash: 'h', sizeBytes: 10 });
    // Touch A (restore) so it becomes the most-recently-used entry.
    expect((await cache.restore({ org, repo, scope: 'shared', key: 'A' })).hit).toBe(true);
    // Saving C pushes the org to 30 > 25 — one entry must go.
    await cache.commitSave({ org, repo, scope: 'shared', key: 'C', tarHash: 'h', sizeBytes: 10 });
    // B is least-recently-used (never restored) → evicted. A (recently used) + C (just created) survive.
    expect((await cache.restore({ org, repo, scope: 'shared', key: 'B' })).hit).toBe(false);
    expect((await cache.restore({ org, repo, scope: 'shared', key: 'A' })).hit).toBe(true);
    expect((await cache.restore({ org, repo, scope: 'shared', key: 'C' })).hit).toBe(true);
    // Eviction is still surfaced as the structured Loki-queryable log line.
    const evictionLogs = mockLogger.info.mock.calls.filter(
      ([msg]) => msg === 'user-cache eviction (org over quota)',
    );
    expect(evictionLogs.length).toBeGreaterThanOrEqual(1);
    const [, fields] = evictionLogs[0] as [string, Record<string, unknown>];
    expect(fields).toMatchObject({ org, freedBytes: 10 });
  });

  it('TTL expiry: an entry past its TTL misses on restore and is lazily deleted', async () => {
    storage = new FakeStorage({ ttlMs: 1000 });
    cache = new UserCache({ storage, quotaBytes: 1_000_000, ttlMs: 1000 });
    await cache.commitSave({ org, repo, scope: 'shared', key: 'k1', tarHash: 'h', sizeBytes: 10 });
    // Fresh: still a hit.
    expect((await cache.restore({ org, repo, scope: 'shared', key: 'k1' })).hit).toBe(true);
    // Advance the logical clock past the TTL window.
    storage.advance(5000);
    // Lazy TTL eviction: restore misses...
    expect((await cache.restore({ org, repo, scope: 'shared', key: 'k1' })).hit).toBe(false);
    // ...and the underlying object was deleted on access.
    const prefix = 'cache/org-1/owner_repo/shared/';
    expect(await storage.has(`${prefix}k1.tar.gz`)).toBe(false);
  });

  describe('per-org limits override (org_settings)', () => {
    it('null reader result falls back to the cluster-wide default quota', async () => {
      // org has no override row → reader returns {} → cluster default quota (25) applies.
      const reader = vi.fn(async () => ({}));
      storage = new FakeStorage();
      cache = new UserCache({
        storage,
        quotaBytes: 25,
        ttlMs: 86_400_000,
        orgLimitsReader: reader,
      });
      await cache.commitSave({ org, repo, scope: 'shared', key: 'a', tarHash: 'h', sizeBytes: 10 });
      await cache.commitSave({ org, repo, scope: 'shared', key: 'b', tarHash: 'h', sizeBytes: 10 });
      await cache.commitSave({ org, repo, scope: 'shared', key: 'c', tarHash: 'h', sizeBytes: 10 }); // 30 > 25
      // Oldest evicted by the cluster default quota.
      expect((await cache.restore({ org, repo, scope: 'shared', key: 'a' })).hit).toBe(false);
      expect((await cache.restore({ org, repo, scope: 'shared', key: 'c' })).hit).toBe(true);
      expect(reader).toHaveBeenCalledWith(org);
    });

    it('per-org quota override takes precedence over the cluster-wide default', async () => {
      // Cluster default quota is huge (no eviction); the per-org override (25) bites.
      const reader = vi.fn(async () => ({ quotaBytes: 25 }));
      storage = new FakeStorage();
      cache = new UserCache({
        storage,
        quotaBytes: 1_000_000,
        ttlMs: 86_400_000,
        orgLimitsReader: reader,
      });
      await cache.commitSave({ org, repo, scope: 'shared', key: 'a', tarHash: 'h', sizeBytes: 10 });
      await cache.commitSave({ org, repo, scope: 'shared', key: 'b', tarHash: 'h', sizeBytes: 10 });
      await cache.commitSave({ org, repo, scope: 'shared', key: 'c', tarHash: 'h', sizeBytes: 10 }); // 30 > 25
      expect((await cache.restore({ org, repo, scope: 'shared', key: 'a' })).hit).toBe(false);
      expect((await cache.restore({ org, repo, scope: 'shared', key: 'c' })).hit).toBe(true);
    });

    it('per-org TTL override expires entries before the cluster-wide default would', async () => {
      // Cluster default TTL is large; per-org override (1000ms) drives expiry.
      storage = new FakeStorage({ ttlMs: 1000 });
      const reader = vi.fn(async () => ({ ttlMs: 1000 }));
      cache = new UserCache({
        storage,
        quotaBytes: 1_000_000,
        ttlMs: 86_400_000, // cluster default: never expire in this test window
        orgLimitsReader: reader,
      });
      await cache.commitSave({
        org,
        repo,
        scope: 'shared',
        key: 'k1',
        tarHash: 'h',
        sizeBytes: 10,
      });
      expect((await cache.restore({ org, repo, scope: 'shared', key: 'k1' })).hit).toBe(true);
      storage.advance(5000); // past the per-org TTL
      expect((await cache.restore({ org, repo, scope: 'shared', key: 'k1' })).hit).toBe(false);
    });

    it('null TTL override falls back to the cluster-wide default TTL', async () => {
      // Reader returns {} (no per-org TTL) → cluster default (1000ms) applies.
      storage = new FakeStorage({ ttlMs: 1000 });
      const reader = vi.fn(async () => ({}));
      cache = new UserCache({
        storage,
        quotaBytes: 1_000_000,
        ttlMs: 1000,
        orgLimitsReader: reader,
      });
      await cache.commitSave({
        org,
        repo,
        scope: 'shared',
        key: 'k1',
        tarHash: 'h',
        sizeBytes: 10,
      });
      expect((await cache.restore({ org, repo, scope: 'shared', key: 'k1' })).hit).toBe(true);
      storage.advance(5000);
      expect((await cache.restore({ org, repo, scope: 'shared', key: 'k1' })).hit).toBe(false);
    });

    it('a reader failure falls back to the cluster-wide defaults (no throw)', async () => {
      const reader = vi.fn(async () => {
        throw new Error('db down');
      });
      storage = new FakeStorage();
      cache = new UserCache({
        storage,
        quotaBytes: 25,
        ttlMs: 86_400_000,
        orgLimitsReader: reader,
      });
      // Despite the reader throwing, the save + restore succeed under the defaults.
      await cache.commitSave({ org, repo, scope: 'shared', key: 'a', tarHash: 'h', sizeBytes: 10 });
      expect((await cache.restore({ org, repo, scope: 'shared', key: 'a' })).hit).toBe(true);
    });
  });
});
