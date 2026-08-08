/**
 * Provider-agnostic LRU cache for lock files.
 *
 * Wraps any LockFileFetcher with an in-memory LRU cache.
 * Cache key: `{repoIdentifier}:{ref}` -- the fetcher handles
 * content-addressable keying internally if the provider supports it.
 *
 * Replaces the old GitHub-specific LockFileCache in github/lockfile.ts.
 */

import { LRUCache } from 'lru-cache';
import { LockFileParseError, type LockFileFetcher, type LockFile } from '@kici-dev/engine';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { assertLockFileRegexesSafe } from './lockfile-redos-guard.js';
import {
  assertLockFileSchemaCompatible,
  assertLockFileMatchersValid,
} from './lockfile-validate.js';

const logger = createLogger({ prefix: 'lockfile-cache' });

export class LockFileCache {
  private readonly cache: LRUCache<string, LockFile>;
  private readonly inFlight = new Map<string, Promise<LockFile | null>>();
  private hits = 0;
  private misses = 0;

  constructor(options: { max: number; ttl: number; maxBytes?: number }) {
    this.cache = new LRUCache<string, LockFile>({
      max: options.max,
      ttl: options.ttl,
      ...(options.maxBytes
        ? {
            maxSize: options.maxBytes,
            // Estimate lock-file bytes once, on the rare cache-miss insert (next
            // to the validation walks). The hot hit path never stringifies. The
            // `|| 1` guards a degenerate/empty lock so sizeCalculation stays a
            // positive integer as lru-cache requires.
            sizeCalculation: (lf: LockFile): number => Buffer.byteLength(JSON.stringify(lf)) || 1,
          }
        : {}),
    });
  }

  /**
   * Fetch the lock file for a repository at a specific ref,
   * using the provided fetcher and LRU caching.
   *
   * @param fetcher - Provider-specific lock file fetcher
   * @param repoIdentifier - Provider-specific repo identifier (e.g., "owner/repo")
   * @param ref - Git ref (branch, tag, or commit SHA)
   * @param credentials - Provider-specific credentials
   * @returns Parsed lock file, or null if not found
   */
  async get(
    fetcher: LockFileFetcher,
    repoIdentifier: string,
    ref: string,
    credentials: unknown,
  ): Promise<LockFile | null> {
    // Scope the cache by `fetcher.provider` so two distinct fetchers (e.g.
    // the internal/canary-repo fetcher and the github fetcher) for the
    // same repo+ref keep separate cache entries. Without this, a successful
    // cross-provider fallback fetch (resolveLockFileWithFallback hops from
    // 'internal' to 'github') would seed the cache under the bare
    // repo:ref key, and the *next* webhook for the same repo would have
    // the original 'internal' fetcher hit that github-fetched entry — the
    // caller would then think it resolved via 'inbound', skip the
    // cross-provider override, and dispatch the job with the local-only
    // file:// clone URL. Remote workers fail to clone that path.
    const cacheKey = `${fetcher.provider}:${repoIdentifier}:${ref}`;

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      this.hits++;
      return cached;
    }

    // Coalesce concurrent misses for the same key onto one fetch + validation
    // walk. Without this, N first-webhooks for one repo:ref all stampede the
    // provider API and all run the three synchronous validation walks.
    const existing = this.inFlight.get(cacheKey);
    if (existing) return existing;

    this.misses++;
    const promise = this.fetchAndValidate(fetcher, repoIdentifier, ref, credentials, cacheKey);
    // Register before the first await so a synchronously-arriving second caller
    // observes the in-flight entry. Clear it in `finally` so a rejection is
    // never retained — a subsequent get re-fetches.
    const tracked = promise.finally(() => {
      this.inFlight.delete(cacheKey);
    });
    this.inFlight.set(cacheKey, tracked);
    return tracked;
  }

  private async fetchAndValidate(
    fetcher: LockFileFetcher,
    repoIdentifier: string,
    ref: string,
    credentials: unknown,
    cacheKey: string,
  ): Promise<LockFile | null> {
    let lockFile: LockFile | null;
    try {
      lockFile = await fetcher.fetchLockFile(repoIdentifier, ref, credentials);
    } catch (error: unknown) {
      if (error instanceof LockFileParseError) {
        // Corrupt lock file is a definitive, customer-actionable failure — do
        // not cache and do not swallow. The resolver surfaces it as lock_resolution.
        logger.warn('Lock file present but unparseable', {
          repoIdentifier,
          ref,
          error: toErrorMessage(error),
        });
        throw error;
      }
      logger.error('Failed to fetch lock file', {
        repoIdentifier,
        ref,
        error: toErrorMessage(error),
      });
      return null;
    }

    if (!lockFile) {
      logger.debug('No lock file found', { repoIdentifier, ref });
      return null;
    }

    // Re-validate the lock before caching or dispatching: schemaVersion
    // compatibility, well-formed routing matchers, and ReDoS-safe regexes. Any
    // failure is a definitive, customer-actionable corrupt lock — surface it as
    // a LockFileParseError so the pipeline records a lockfile_corrupt run.
    // Ordering matters: matcher-shape rejection runs before the ReDoS check,
    // which assumes well-formed matchers.
    try {
      assertLockFileSchemaCompatible(lockFile, repoIdentifier, ref);
      assertLockFileMatchersValid(lockFile);
      assertLockFileRegexesSafe(lockFile);
    } catch (error: unknown) {
      const message = toErrorMessage(error);
      logger.warn('Lock file failed post-fetch validation', {
        repoIdentifier,
        ref,
        error: message,
      });
      // The schema gate already raises a repo/ref-tagged LockFileParseError with
      // operator-actionable guidance; rethrow it verbatim. The matcher/regex
      // asserts throw bare Errors, so wrap those into the corrupt-lock signal.
      if (error instanceof LockFileParseError) throw error;
      throw new LockFileParseError(repoIdentifier, ref, message);
    }

    this.cache.set(cacheKey, lockFile);
    return lockFile;
  }

  /**
   * Get cache statistics for metrics/monitoring.
   */
  getStats(): { hits: number; misses: number; size: number; calculatedSize: number } {
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size,
      calculatedSize: this.cache.calculatedSize,
    };
  }
}
