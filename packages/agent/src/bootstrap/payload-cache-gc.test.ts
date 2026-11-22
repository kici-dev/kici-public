import { existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempDir } from '@kici-dev/test-support/tmp';
import {
  evictStalePayloadVersions,
  PAYLOAD_CACHE_KEEP_VERSIONS,
  PAYLOAD_CACHE_MIN_IDLE_MS,
  selectEvictablePayloadVersions,
} from './payload-cache-gc.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

describe('selectEvictablePayloadVersions', () => {
  it('keeps the most recently used versions and evicts the idle rest', () => {
    // fails-when: no count limit — every version idle for a day goes, so the
    // previous release a rollback needs is downloaded again.
    const entries = [
      { version: '0.30.0', lastUsedMs: NOW },
      { version: '0.29.0', lastUsedMs: NOW - 2 * DAY },
      { version: '0.28.0', lastUsedMs: NOW - 3 * DAY },
      { version: '0.27.0', lastUsedMs: NOW - 4 * DAY },
      { version: '0.2.0', lastUsedMs: NOW - 90 * DAY },
    ];
    expect(selectEvictablePayloadVersions(entries, '0.30.0', NOW).sort()).toEqual([
      '0.2.0',
      '0.27.0',
    ]);
    expect(PAYLOAD_CACHE_KEEP_VERSIONS).toBe(3);
  });

  it('never evicts a version used within the idle window, whatever the count', () => {
    // fails-when: only the count gates eviction — a concurrent bring-up that
    // resolved its version minutes ago loses the tarball it is about to stream.
    const entries = [
      { version: 'a', lastUsedMs: NOW },
      { version: 'b', lastUsedMs: NOW - 1000 },
      { version: 'c', lastUsedMs: NOW - 2000 },
      { version: 'd', lastUsedMs: NOW - PAYLOAD_CACHE_MIN_IDLE_MS + 1 },
    ];
    expect(selectEvictablePayloadVersions(entries, 'a', NOW)).toEqual([]);
  });

  it('never evicts the current version, even when its mtime is the oldest', () => {
    // breaks-if-wrong: the version being resolved survives even if marking it
    // used failed and its directory still carries an old mtime.
    const entries = [
      { version: 'new1', lastUsedMs: NOW },
      { version: 'new2', lastUsedMs: NOW - 1 },
      { version: 'new3', lastUsedMs: NOW - 2 },
      { version: 'current', lastUsedMs: NOW - 30 * DAY },
    ];
    expect(selectEvictablePayloadVersions(entries, 'current', NOW)).toEqual([]);
  });
});

describe('evictStalePayloadVersions', () => {
  function seed(cacheDir: string, version: string, ageMs: number): string {
    const dir = path.join(cacheDir, version);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'kici-agent-linux-x64.tar.gz'), 'x');
    const t = new Date(NOW - ageMs);
    utimesSync(dir, t, t);
    return dir;
  }

  it('marks the current version used and removes the stale versions on disk', async () => {
    const cacheDir = makeTempDir('payload-cache-gc-');
    const current = seed(cacheDir, '0.30.0', 40 * DAY);
    seed(cacheDir, '0.29.0', 2 * DAY);
    seed(cacheDir, '0.28.0', 3 * DAY);
    const stale = seed(cacheDir, '0.2.0', 90 * DAY);
    writeFileSync(path.join(cacheDir, 'stray-file'), 'not a version');

    const removed = await evictStalePayloadVersions(cacheDir, '0.30.0', NOW);

    expect(removed).toEqual(['0.2.0']);
    expect(existsSync(stale)).toBe(false);
    expect(statSync(current).mtimeMs).toBe(NOW);
    expect(existsSync(path.join(cacheDir, '0.29.0'))).toBe(true);
    expect(existsSync(path.join(cacheDir, 'stray-file'))).toBe(true);
  });

  it('never throws, even when the cache directory is missing', async () => {
    const cacheDir = path.join(makeTempDir('payload-cache-gc-'), 'absent');
    await expect(evictStalePayloadVersions(cacheDir, '1.0.0', NOW)).resolves.toEqual([]);
  });
});
