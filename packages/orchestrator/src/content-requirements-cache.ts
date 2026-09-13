/**
 * Provider-agnostic LRU cache for source-file contents fetched at a ref.
 *
 * Wraps any {@link FileContentsFetcher} with an in-memory LRU cache keyed by
 * `(provider, repo, sha, path)`. The key is content-addressable by
 * construction: a commit SHA pins immutable bytes, so a cached entry for a
 * `(repo, sha, path)` triple can never go stale within the SHA. When the caller
 * passes a mutable ref (a branch name) instead of a SHA, staleness is bounded by
 * the TTL, exactly as the lock-file cache handles the same case.
 *
 * Mirrors {@link ../lockfile-cache.ts LockFileCache}: same LRU + in-flight
 * coalescing shape so N concurrent misses for one key run a single fetch.
 */

import { LRUCache } from 'lru-cache';
import type { FileContentsFetcher } from '@kici-dev/engine';
import { createLogger } from '@kici-dev/shared';

const logger = createLogger({ prefix: 'content-cache' });

/**
 * One fetched file's presence + bytes. `present: true` with `bytes: undefined`
 * is the size-limit case (the file exists but the provider returned no inline
 * content, e.g. a GitHub file over 1 MiB) — callers MUST treat it as
 * "content unavailable for matching", never as an absent or empty file.
 */
export interface FileContentEntry {
  readonly present: boolean;
  readonly bytes?: string;
}

/** Overhead added to each entry's measured size so a present-without-bytes row is still counted. */
const ENTRY_SIZE_OVERHEAD_BYTES = 64;

export class ContentRequirementsCache {
  private readonly cache: LRUCache<string, FileContentEntry>;
  private readonly inFlight = new Map<string, Promise<FileContentEntry>>();
  private hits = 0;
  private misses = 0;

  constructor(options: { max: number; ttl: number; maxBytes?: number }) {
    this.cache = new LRUCache<string, FileContentEntry>({
      max: options.max,
      ttl: options.ttl,
      ...(options.maxBytes
        ? {
            maxSize: options.maxBytes,
            // Bytes dominate the entry footprint; a present-without-bytes row
            // still costs the fixed overhead so sizeCalculation stays a positive
            // integer as lru-cache requires.
            sizeCalculation: (entry: FileContentEntry): number =>
              (entry.bytes ? Buffer.byteLength(entry.bytes) : 0) + ENTRY_SIZE_OVERHEAD_BYTES,
          }
        : {}),
    });
  }

  /**
   * Fetch a file's contents at a ref, using the provided fetcher and LRU
   * caching. Each distinct `(provider, repo, sha, path)` is fetched at most
   * once; concurrent misses coalesce onto one fetch.
   *
   * @param fetcher - Provider-specific file-contents fetcher.
   * @param repo    - Provider repo identifier ("owner/repo").
   * @param sha     - Git ref (commit SHA, or a branch/tag name).
   * @param path    - Repo-relative file path.
   */
  async get(
    fetcher: FileContentsFetcher,
    repo: string,
    sha: string,
    path: string,
  ): Promise<FileContentEntry> {
    // Scope the key by `fetcher.provider` (mirrors LockFileCache) so two distinct
    // providers owning the same repo:sha:path keep separate entries.
    const cacheKey = `${fetcher.provider}:${repo}:${sha}:${path}`;

    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      this.hits++;
      return cached;
    }

    // Coalesce concurrent misses for one key onto a single fetch.
    const existing = this.inFlight.get(cacheKey);
    if (existing) return existing;

    this.misses++;
    const promise = this.fetchAndCache(fetcher, repo, sha, path, cacheKey);
    // Register before the first await so a synchronously-arriving second caller
    // observes the in-flight entry. Clear in `finally` so a rejection is never
    // retained — a subsequent get re-fetches.
    const tracked = promise.finally(() => {
      this.inFlight.delete(cacheKey);
    });
    this.inFlight.set(cacheKey, tracked);
    return tracked;
  }

  private async fetchAndCache(
    fetcher: FileContentsFetcher,
    repo: string,
    sha: string,
    path: string,
    cacheKey: string,
  ): Promise<FileContentEntry> {
    const slash = repo.indexOf('/');
    const owner = slash >= 0 ? repo.slice(0, slash) : repo;
    const name = slash >= 0 ? repo.slice(slash + 1) : '';

    const result = await fetcher.getFileContents(owner, name, path, sha);
    const entry: FileContentEntry = {
      present: result.present,
      ...(result.bytes !== undefined && { bytes: result.bytes }),
    };
    this.cache.set(cacheKey, entry);
    logger.debug('Fetched file contents at ref', {
      repo,
      sha,
      path,
      present: entry.present,
      hasBytes: entry.bytes !== undefined,
    });
    return entry;
  }

  /** Cache statistics for metrics/monitoring. */
  getStats(): { hits: number; misses: number; size: number; calculatedSize: number } {
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size,
      calculatedSize: this.cache.calculatedSize,
    };
  }
}
