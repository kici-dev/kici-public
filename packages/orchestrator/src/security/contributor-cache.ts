/**
 * LRU cache wrapper for ContributorResolver.
 *
 * Caches contributor permission lookups to prevent redundant API calls.
 * Uses a 15-minute TTL and 10,000 max entries.
 */

import { LRUCache } from 'lru-cache';
import type { ContributorResolver, ContributorInfo } from '@kici-dev/engine';

/** Default TTL for cached contributor info: 15 minutes. */
const DEFAULT_TTL_MS = 15 * 60 * 1000;

/** Default maximum number of cached entries. */
const DEFAULT_MAX_ENTRIES = 10_000;

/**
 * Caches ContributorResolver results in an LRU cache.
 *
 * Cache key format: `{provider}:{repoFullName}:{username}`
 * TTL: 15 minutes (configurable for testing).
 */
export class ContributorCache {
  private readonly cache: LRUCache<string, ContributorInfo>;

  constructor(options?: { ttlMs?: number; maxEntries?: number }) {
    this.cache = new LRUCache<string, ContributorInfo>({
      max: options?.maxEntries ?? DEFAULT_MAX_ENTRIES,
      ttl: options?.ttlMs ?? DEFAULT_TTL_MS,
    });
  }

  /**
   * Build the cache key from provider, repo, and username.
   */
  private buildKey(provider: string, repoFullName: string, username: string): string {
    return `${provider}:${repoFullName}:${username}`;
  }

  /**
   * Resolve contributor info, using cache when available.
   *
   * @param provider - Provider identifier (e.g. 'github')
   * @param repoFullName - Full repo identifier (e.g. 'owner/repo')
   * @param username - Contributor username
   * @param resolver - ContributorResolver to call on cache miss
   * @param credentials - Provider credentials for API calls
   * @returns Cached or freshly resolved ContributorInfo
   */
  async resolve(
    provider: string,
    repoFullName: string,
    username: string,
    resolver: ContributorResolver,
    credentials: unknown,
  ): Promise<ContributorInfo> {
    const key = this.buildKey(provider, repoFullName, username);

    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }

    const info = await resolver.resolveContributor(repoFullName, username, credentials);
    this.cache.set(key, info);
    return info;
  }

  /**
   * Explicitly invalidate a cached entry.
   *
   * @returns 1 if an entry was present and deleted, 0 otherwise. Symmetric
   * with the bulk invalidators so callers can accumulate a total.
   */
  invalidate(provider: string, repoFullName: string, username: string): number {
    const key = this.buildKey(provider, repoFullName, username);
    return this.cache.delete(key) ? 1 : 0;
  }

  /**
   * Invalidate every cached entry for a specific repository.
   *
   * Scans the LRU (bounded to `maxEntries`) and deletes entries whose key
   * prefix matches `{provider}:{repoFullName}:`. Used when a webhook event
   * signals a repo-wide permission change (e.g. GitHub `team.added_to_repository`
   * / `team.removed_from_repository`) where every contributor's effective
   * permission on that repo may have shifted.
   *
   * @returns Number of entries deleted.
   */
  invalidateByRepo(provider: string, repoFullName: string): number {
    const prefix = `${provider}:${repoFullName}:`;
    let count = 0;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Invalidate every cached entry for a user across all repositories in an org.
   *
   * Scans the LRU and deletes entries whose key matches
   * `{provider}:{orgLogin}/*:{username}`. Used when a webhook event signals
   * that a user's membership in an org changed (e.g. GitHub `organization`,
   * `membership` events), since any repo under that org could now return a
   * different permission for the user.
   *
   * @returns Number of entries deleted.
   */
  invalidateByUserInOrg(provider: string, orgLogin: string, username: string): number {
    const repoPrefix = `${provider}:${orgLogin}/`;
    const userSuffix = `:${username}`;
    let count = 0;
    for (const key of this.cache.keys()) {
      if (key.startsWith(repoPrefix) && key.endsWith(userSuffix)) {
        this.cache.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Clear all cached entries. Useful for testing.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get the current number of cached entries.
   */
  get size(): number {
    return this.cache.size;
  }
}
