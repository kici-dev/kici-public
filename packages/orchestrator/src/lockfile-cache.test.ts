import { describe, it, expect, vi } from 'vitest';
import {
  LockFileParseError,
  SCHEMA_VERSION,
  BREAKING_FLOOR,
  type LockFile,
  type LockFileFetcher,
} from '@kici-dev/engine';
import { LockFileCache } from './lockfile-cache.js';

const SAMPLE_LOCK: LockFile = {
  schemaVersion: SCHEMA_VERSION,
  source: { file: '.kici/workflows/ci.ts', export: '#default' },
  contentHash: 'h',
  workflows: [],
} as unknown as LockFile;

function makeFetcher(
  impl: LockFileFetcher['fetchLockFile'],
): LockFileFetcher & { fetchLockFile: ReturnType<typeof vi.fn> } {
  return {
    provider: 'github' as const,
    fetchLockFile: vi.fn(impl),
  } as unknown as LockFileFetcher & { fetchLockFile: ReturnType<typeof vi.fn> };
}

describe('LockFileCache', () => {
  it('caches a successful fetch', async () => {
    const fetcher = makeFetcher(async () => SAMPLE_LOCK);
    const cache = new LockFileCache({ max: 10, ttl: 60_000 });
    await expect(cache.get(fetcher, 'a/b', 'main', {})).resolves.toEqual(SAMPLE_LOCK);
    await expect(cache.get(fetcher, 'a/b', 'main', {})).resolves.toEqual(SAMPLE_LOCK);
    expect(fetcher.fetchLockFile).toHaveBeenCalledTimes(1);
  });

  it('re-throws LockFileParseError (corrupt lock is definitive, not cached)', async () => {
    const fetcher = makeFetcher(async () => {
      throw new LockFileParseError('a/b', 'main', 'bad');
    });
    const cache = new LockFileCache({ max: 10, ttl: 60_000 });
    await expect(cache.get(fetcher, 'a/b', 'main', {})).rejects.toBeInstanceOf(LockFileParseError);
    // Not cached: a second call hits the fetcher again.
    await expect(cache.get(fetcher, 'a/b', 'main', {})).rejects.toBeInstanceOf(LockFileParseError);
    expect(fetcher.fetchLockFile).toHaveBeenCalledTimes(2);
  });

  it('still swallows transient (non-parse) errors to null', async () => {
    const fetcher = makeFetcher(async () => {
      throw new Error('ETIMEDOUT');
    });
    const cache = new LockFileCache({ max: 10, ttl: 60_000 });
    await expect(cache.get(fetcher, 'a/b', 'main', {})).resolves.toBeNull();
  });

  it('throws LockFileParseError for a below-floor schemaVersion', async () => {
    const staleLock = {
      schemaVersion: BREAKING_FLOOR - 1,
      source: { file: 't', export: '#default' },
      contentHash: 'h',
      workflows: [],
    } as unknown as LockFile;
    const fetcher = makeFetcher(async () => staleLock);
    const cache = new LockFileCache({ max: 10, ttl: 60_000 });
    await expect(cache.get(fetcher, 'a/b', 'main', {})).rejects.toBeInstanceOf(LockFileParseError);
  });

  it('throws LockFileParseError for a stale string-array runsOn at the current schemaVersion', async () => {
    const staleRunsOn = {
      schemaVersion: SCHEMA_VERSION,
      source: { file: 't', export: '#default' },
      contentHash: 'h',
      workflows: [
        {
          name: 'wf',
          jobs: [{ _type: 'static', name: 'job', steps: [], runsOn: ['firecracker'] }],
        },
      ],
    } as unknown as LockFile;
    const fetcher = makeFetcher(async () => staleRunsOn);
    const cache = new LockFileCache({ max: 10, ttl: 60_000 });
    await expect(cache.get(fetcher, 'a/b', 'main', {})).rejects.toBeInstanceOf(LockFileParseError);
  });
});

describe('LockFileCache single-flight', () => {
  it('coalesces concurrent misses for one key into a single fetch', async () => {
    let release!: (v: LockFile) => void;
    const gate = new Promise<LockFile>((r) => (release = r));
    const fetcher = makeFetcher(async () => gate);
    const cache = new LockFileCache({ max: 10, ttl: 60_000 });

    const p1 = cache.get(fetcher, 'a/b', 'main', {});
    const p2 = cache.get(fetcher, 'a/b', 'main', {});
    const p3 = cache.get(fetcher, 'a/b', 'main', {});
    release(SAMPLE_LOCK);
    const [a, b, c] = await Promise.all([p1, p2, p3]);

    expect(a).toEqual(SAMPLE_LOCK);
    expect(b).toEqual(SAMPLE_LOCK);
    expect(c).toEqual(SAMPLE_LOCK);
    expect(fetcher.fetchLockFile).toHaveBeenCalledTimes(1);
  });

  it('does not cross keys — a different repo:ref gets its own fetch', async () => {
    const fetcher = makeFetcher(async () => SAMPLE_LOCK);
    const cache = new LockFileCache({ max: 10, ttl: 60_000 });
    await Promise.all([
      cache.get(fetcher, 'a/b', 'main', {}),
      cache.get(fetcher, 'a/b', 'dev', {}),
    ]);
    expect(fetcher.fetchLockFile).toHaveBeenCalledTimes(2);
  });

  it('propagates a parse error to all coalesced waiters and caches nothing', async () => {
    let count = 0;
    const fetcher = makeFetcher(async () => {
      count++;
      throw new LockFileParseError('a/b', 'main', 'bad');
    });
    const cache = new LockFileCache({ max: 10, ttl: 60_000 });

    const p1 = cache.get(fetcher, 'a/b', 'main', {});
    const p2 = cache.get(fetcher, 'a/b', 'main', {});
    await expect(p1).rejects.toBeInstanceOf(LockFileParseError);
    await expect(p2).rejects.toBeInstanceOf(LockFileParseError);
    expect(count).toBe(1);

    // The rejection is cleared, so a fresh call re-fetches (nothing cached).
    await expect(cache.get(fetcher, 'a/b', 'main', {})).rejects.toBeInstanceOf(LockFileParseError);
    expect(count).toBe(2);
  });

  it('a second get after an in-flight fetch completes serves the cached value', async () => {
    const fetcher = makeFetcher(async () => SAMPLE_LOCK);
    const cache = new LockFileCache({ max: 10, ttl: 60_000 });
    await cache.get(fetcher, 'a/b', 'main', {});
    await cache.get(fetcher, 'a/b', 'main', {});
    expect(fetcher.fetchLockFile).toHaveBeenCalledTimes(1);
    expect(cache.getStats().hits).toBe(1);
  });
});

describe('LockFileCache byte bound', () => {
  const bigLock = (h: string): LockFile =>
    ({
      schemaVersion: SCHEMA_VERSION,
      source: { file: '.kici/workflows/ci.ts', export: '#default' },
      contentHash: h.repeat(5000),
      workflows: [],
    }) as unknown as LockFile;

  it('evicts by byte size when maxBytes is exceeded', async () => {
    const cache = new LockFileCache({ max: 100, ttl: 60_000, maxBytes: 6000 });
    await cache.get(
      makeFetcher(async () => bigLock('a')),
      'o/r',
      'a',
      {},
    );
    await cache.get(
      makeFetcher(async () => bigLock('b')),
      'o/r',
      'b',
      {},
    );
    // Two ~5KB entries exceed the 6KB budget → the first is evicted.
    const stats = cache.getStats();
    expect(stats.size).toBe(1);
    expect(stats.calculatedSize).toBeLessThanOrEqual(6000);
    expect(stats.calculatedSize).toBeGreaterThan(0);
  });

  it('reports calculatedSize 0 and keeps entry-count bound when maxBytes is unset', async () => {
    const cache = new LockFileCache({ max: 100, ttl: 60_000 });
    await cache.get(
      makeFetcher(async () => bigLock('a')),
      'o/r',
      'a',
      {},
    );
    await cache.get(
      makeFetcher(async () => bigLock('b')),
      'o/r',
      'b',
      {},
    );
    const stats = cache.getStats();
    expect(stats.size).toBe(2);
    expect(stats.calculatedSize).toBe(0);
  });
});
