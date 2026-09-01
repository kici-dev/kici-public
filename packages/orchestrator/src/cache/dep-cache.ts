/**
 * Dependency-specific cache layer wrapping CacheStorage.
 *
 * Stores dependency tarballs under their own content hash, with a small pointer
 * resolving lockfileHash + platform + arch to that hash. Shared CacheStorage
 * backend with SourceCache (same S3 bucket). Refreshes TTL on reads
 * (touch-on-read).
 *
 * Keys: `deps/{platform}-{arch}/{depsHash}.tar.gz` (immutable) and
 * `deps/{platform}-{arch}/{lockfileHash}.hash` (the pointer).
 */

import { createLogger, sha256 } from '@kici-dev/shared';
import type { CacheStorage } from '../storage/types.js';
import type { ClusterSettingsReader } from '../cluster/cluster-settings-reader.js';

const logger = createLogger({ prefix: 'dep-cache' });

/** Default max tarball size: 500MB */
const DEFAULT_MAX_TARBALL_BYTES = 524_288_000;

/** Default dependency-cache entry TTL: 30 days. */
const DEFAULT_CACHE_TTL_DAYS = 30;

const MS_PER_DAY = 86_400_000;

/**
 * Cache key for a dependency tarball, addressed by the tarball's OWN content
 * hash: `deps/{platform}-{arch}/{depsHash}.tar.gz`.
 *
 * Content-addressing is what makes a mismatched pair unrepresentable. When the
 * tarball lived at a lockfile-derived name, it and its companion `.hash` were
 * two independently-written objects under keys that any two builds sharing a
 * lockfile + platform + arch also share — so concurrent builders could leave the
 * `.tar.gz` from one and the `.hash` from the other, and the reader failed
 * verification durably. Naming the object by its own hash means every pair a
 * reader can observe is self-consistent, and the bytes at a given key can never
 * change after a URL is signed for it.
 */
export function depTarballKey(depsHash: string, platform: string, arch: string): string {
  return `deps/${platform}-${arch}/${depsHash}.tar.gz`;
}

/**
 * Cache key for the pointer that resolves a lockfile to the content hash of the
 * tarball built from it: `deps/{platform}-{arch}/{lockfileHash}.hash`.
 *
 * This is the one mutable object in the scheme. A concurrent write replaces a
 * pointer wholesale — there is no window in which it is half-written — so the
 * worst a racing pair of builders can do is leave whichever pointer landed last,
 * and both tarballs remain valid and fetchable.
 */
export function depPointerKey(lockfileHash: string, platform: string, arch: string): string {
  return `deps/${platform}-${arch}/${lockfileHash}.hash`;
}

export class DepCache {
  private readonly storage: CacheStorage;
  private readonly maxTarballBytes: number;
  private readonly cacheTtlDaysFallback: number;
  private readonly clusterSettings?: ClusterSettingsReader;

  constructor(options: {
    storage: CacheStorage;
    maxTarballBytes?: number;
    /** Cluster default for the dependency-cache entry TTL, in days. */
    cacheTtlDaysFallback?: number;
    /** Reader for the fleet-wide `cache_max_tarball_bytes` / `cache_ttl_days` overrides. */
    clusterSettings?: ClusterSettingsReader;
  }) {
    this.storage = options.storage;
    this.maxTarballBytes = options.maxTarballBytes ?? DEFAULT_MAX_TARBALL_BYTES;
    this.cacheTtlDaysFallback = options.cacheTtlDaysFallback ?? DEFAULT_CACHE_TTL_DAYS;
    this.clusterSettings = options.clusterSettings;
  }

  /**
   * Resolve the live dependency-cache entry TTL as a per-operation override
   * (ms) from `cluster_settings.cache_ttl_days`, falling back to the cluster
   * default. `undefined` when no reader is wired, so the storage backend uses
   * its own configured TTL. Passed to read/expiry operations so an operator's
   * `cache_ttl_days` change takes effect on the next lookup.
   */
  private async resolveTtlMsOverride(): Promise<number | undefined> {
    if (!this.clusterSettings) return undefined;
    const days = await this.clusterSettings.getNumber('cache_ttl_days', this.cacheTtlDaysFallback);
    return days * MS_PER_DAY;
  }

  /**
   * Resolve a lockfile to the content hash of the tarball built from it, or
   * null when no pointer exists. The single place the indirection is read.
   */
  private async resolvePointer(
    lockfileHash: string,
    platform: string,
    arch: string,
    ttlMsOverride: number | undefined,
  ): Promise<string | null> {
    const data = await this.storage.get(depPointerKey(lockfileHash, platform, arch), ttlMsOverride);
    return data?.toString('utf-8').trim() || null;
  }

  /**
   * Check if a dep tarball exists in cache.
   *
   * Both halves must be present: a pointer whose tarball has aged out is a miss,
   * not a hit, or the caller skips a rebuild and dispatches a URL that 404s.
   */
  async has(lockfileHash: string, platform: string, arch: string): Promise<boolean> {
    const ttlMsOverride = await this.resolveTtlMsOverride();
    const depsHash = await this.resolvePointer(lockfileHash, platform, arch, ttlMsOverride);
    if (!depsHash) {
      logger.debug(`has(${lockfileHash}): false (no pointer)`, { platform, arch });
      return false;
    }
    const exists = await this.storage.has(depTarballKey(depsHash, platform, arch), ttlMsOverride);
    logger.debug(`has(${lockfileHash}): ${exists}`, { platform, arch });
    return exists;
  }

  /**
   * Get a pre-signed download URL for the dep tarball (for agent delivery).
   * Refreshes TTL on hit.
   */
  async getUrl(lockfileHash: string, platform: string, arch: string): Promise<string | null> {
    // Delegates so the pointer indirection lives in exactly one place — a second
    // copy is how the url and the hash drift apart again.
    const hit = await this.getUrlAndHash(lockfileHash, platform, arch);
    return hit?.url ?? null;
  }

  /**
   * Get a pre-signed download URL and the tarball content hash.
   *
   * Returns null on cache miss — including an entry with no pointer, which is
   * unverifiable and so is deliberately not served.
   */
  async getUrlAndHash(
    lockfileHash: string,
    platform: string,
    arch: string,
  ): Promise<{ url: string; hash?: string } | null> {
    const ttlMsOverride = await this.resolveTtlMsOverride();

    // Resolve the pointer FIRST. It names the content hash, which is also the
    // tarball's key — so the url and the hash returned below are read from a
    // single source of truth and cannot disagree.
    const pointerKey = depPointerKey(lockfileHash, platform, arch);
    const pointerData = await this.storage.get(pointerKey, ttlMsOverride);
    const hash = pointerData?.toString('utf-8').trim() || undefined;
    if (!hash) {
      logger.debug(`getUrlAndHash(${lockfileHash}): miss (no pointer)`, { platform, arch });
      return null;
    }

    const key = depTarballKey(hash, platform, arch);
    const url = await this.storage.getUrl(key, ttlMsOverride);
    if (!url) {
      // A pointer with no tarball behind it. Possible when the tarball aged out
      // while the tiny pointer was still live, since they expire independently.
      // Report a miss so the caller rebuilds rather than dispatching a URL that
      // 404s on the agent.
      logger.debug(`getUrlAndHash(${lockfileHash}): miss (dangling pointer)`, { platform, arch });
      return null;
    }
    // Touch both so a live entry's two halves age together.
    await this.storage.touch(key);
    await this.storage.touch(pointerKey);
    logger.debug(`getUrlAndHash(${lockfileHash}): hit`, { platform, arch, hasHash: true });
    return { url, hash };
  }

  /**
   * Get a pre-signed upload URL for direct agent-to-S3 upload.
   */
  async getUploadUrl(depsHash: string, platform: string, arch: string): Promise<string> {
    // Takes the tarball's OWN hash, not the lockfile hash: the agent computes it
    // before asking for a URL, and the object is named by it.
    return this.storage.getUploadUrl(depTarballKey(depsHash, platform, arch));
  }

  /**
   * Publish the pointer that makes an uploaded tarball discoverable by lockfile.
   *
   * Called only after the agent confirms its upload completed. Publishing before
   * the bytes land would let a reader follow the pointer to a missing object.
   */
  async publishPointer(
    lockfileHash: string,
    platform: string,
    arch: string,
    depsHash: string,
  ): Promise<void> {
    await this.storage.put(depPointerKey(lockfileHash, platform, arch), depsHash);
    logger.info(`publishPointer(${lockfileHash}) -> ${depsHash.slice(0, 12)}`, { platform, arch });
  }

  /**
   * Store a dep tarball in cache.
   * Throws if tarball exceeds max size (per user decision).
   */
  async store(
    lockfileHash: string,
    platform: string,
    arch: string,
    tarballData: Buffer,
  ): Promise<void> {
    const maxTarballBytes = this.clusterSettings
      ? await this.clusterSettings.getNumber('cache_max_tarball_bytes', this.maxTarballBytes)
      : this.maxTarballBytes;
    if (tarballData.length > maxTarballBytes) {
      throw new Error(
        `Dep tarball exceeds max size: ${tarballData.length} bytes > ${maxTarballBytes} bytes limit`,
      );
    }
    // Order is load-bearing: the tarball must exist before any pointer names it,
    // or a reader can follow a pointer to an object that is not there yet.
    const depsHash = DepCache.computeHash(tarballData);
    await this.storage.put(depTarballKey(depsHash, platform, arch), tarballData);
    await this.storage.put(depPointerKey(lockfileHash, platform, arch), depsHash);
    logger.info(`store: ${tarballData.length} bytes`, {
      lockfileHash,
      platform,
      arch,
      depsHash: depsHash.slice(0, 12),
    });
  }

  /**
   * Compute SHA-256 hash of a tarball buffer.
   * Used by build agents to compute the hash for depsHash protocol field.
   */
  static computeHash(data: Buffer): string {
    return sha256(data);
  }

  /** Remove a dep tarball and its pointer from cache. */
  async remove(lockfileHash: string, platform: string, arch: string): Promise<boolean> {
    const depsHash = await this.resolvePointer(
      lockfileHash,
      platform,
      arch,
      await this.resolveTtlMsOverride(),
    );
    // Drop the pointer first so nothing can resolve to a tarball being deleted.
    await this.storage.delete(depPointerKey(lockfileHash, platform, arch));
    const removed = depsHash
      ? await this.storage.delete(depTarballKey(depsHash, platform, arch))
      : false;
    logger.info(`remove(${lockfileHash}): ${removed ? 'removed' : 'not found'}`, {
      platform,
      arch,
    });
    return removed;
  }
}
