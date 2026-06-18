import { describe, it, expect, vi } from 'vitest';
import { LockFileParseError, type LockFile, type LockFileFetcher } from '@kici-dev/engine';
import { LockFileCache } from './lockfile-cache.js';

const SAMPLE_LOCK: LockFile = {
  schemaVersion: 1,
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
});
