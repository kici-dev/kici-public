/**
 * Eviction for the ops agent's version-keyed payload cache
 * (`<cacheDir>/<version>/kici-agent-<platform>.tar.gz`, see s3-payload-source.ts).
 *
 * The cache is cache-once per version, so every orchestrator upgrade adds a
 * ~70 MB directory, and without eviction a long-lived bare-metal agent keeps
 * one per release forever. Each resolve marks its version directory as used
 * (its mtime), then removes the versions that are both outside the most
 * recently used few and idle for a day. The idle floor is what keeps a
 * concurrent bring-up safe: the agent sharing this cache marked its version
 * when it resolved it, minutes before it streams the tarball.
 */

import { readdir, rm, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { createLogger, toErrorMessage } from '@kici-dev/shared';

const logger = createLogger({ prefix: 'payload-cache' });

/** Versions kept whatever their age: the one just resolved plus the most
 *  recently used before it, so a rollback to the previous release re-stages
 *  without a download. */
export const PAYLOAD_CACHE_KEEP_VERSIONS = 3;

/** A version used within this window is never evicted. */
export const PAYLOAD_CACHE_MIN_IDLE_MS = 24 * 60 * 60 * 1000;

export interface PayloadCacheEntry {
  version: string;
  /** The version directory's mtime: when a resolve last used it. */
  lastUsedMs: number;
}

/**
 * The versions to evict: not the current one, not among the `keep` most
 * recently used, and idle for at least `minIdleMs`.
 */
export function selectEvictablePayloadVersions(
  entries: readonly PayloadCacheEntry[],
  currentVersion: string,
  nowMs: number,
  keep: number = PAYLOAD_CACHE_KEEP_VERSIONS,
  minIdleMs: number = PAYLOAD_CACHE_MIN_IDLE_MS,
): string[] {
  const kept = new Set(
    [...entries]
      .sort((a, b) => b.lastUsedMs - a.lastUsedMs)
      .slice(0, keep)
      .map((e) => e.version),
  );
  kept.add(currentVersion);
  return entries
    .filter((e) => !kept.has(e.version) && nowMs - e.lastUsedMs >= minIdleMs)
    .map((e) => e.version);
}

/**
 * Mark `currentVersion` as used and remove the evictable versions under
 * `cacheDir`. Returns the removed version names. Never throws: a failed
 * eviction must not fail the bring-up that triggered it.
 */
export async function evictStalePayloadVersions(
  cacheDir: string,
  currentVersion: string,
  nowMs: number = Date.now(),
): Promise<string[]> {
  const removed: string[] = [];
  try {
    const now = new Date(nowMs);
    await utimes(path.join(cacheDir, currentVersion), now, now);
    const entries: PayloadCacheEntry[] = [];
    for (const dirent of await readdir(cacheDir, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const s = await stat(path.join(cacheDir, dirent.name));
      entries.push({ version: dirent.name, lastUsedMs: s.mtimeMs });
    }
    for (const version of selectEvictablePayloadVersions(entries, currentVersion, nowMs)) {
      try {
        await rm(path.join(cacheDir, version), { recursive: true, force: true });
        removed.push(version);
      } catch (err) {
        logger.warn('Failed to evict cached agent payload', {
          version,
          error: toErrorMessage(err),
        });
      }
    }
    if (removed.length > 0) {
      logger.info('Evicted cached agent payloads', { cacheDir, versions: removed });
    }
  } catch (err) {
    logger.warn('Agent payload cache eviction skipped', {
      cacheDir,
      error: toErrorMessage(err),
    });
  }
  return removed;
}
