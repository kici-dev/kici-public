/**
 * Dependency-specific cache layer wrapping CacheStorage.
 *
 * Stores and retrieves dependency tarballs keyed by lockfileHash + platform + arch.
 * Shared CacheStorage backend with SourceCache (same S3 bucket).
 * Refreshes TTL on reads (touch-on-read).
 *
 * Cache key format: deps/{platform}-{arch}/{lockfileHash}.tar.gz
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

/** Build cache key for dependency tarball: deps/{platform}-{arch}/{lockfileHash}.tar.gz */
function depKey(lockfileHash: string, platform: string, arch: string): string {
  return `deps/${platform}-${arch}/${lockfileHash}.tar.gz`;
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

  /** Check if a dep tarball exists in cache. */
  async has(lockfileHash: string, platform: string, arch: string): Promise<boolean> {
    const key = depKey(lockfileHash, platform, arch);
    const exists = await this.storage.has(key, await this.resolveTtlMsOverride());
    logger.debug(`has(${lockfileHash}): ${exists}`, { platform, arch });
    return exists;
  }

  /**
   * Get a pre-signed download URL for the dep tarball (for agent delivery).
   * Refreshes TTL on hit.
   */
  async getUrl(lockfileHash: string, platform: string, arch: string): Promise<string | null> {
    const key = depKey(lockfileHash, platform, arch);
    const url = await this.storage.getUrl(key, await this.resolveTtlMsOverride());
    if (url) {
      await this.storage.touch(key);
      logger.debug(`getUrl(${lockfileHash}): hit`, { platform, arch });
    } else {
      logger.debug(`getUrl(${lockfileHash}): miss`, { platform, arch });
    }
    return url;
  }

  /**
   * Get a pre-signed download URL and the tarball content hash (if available).
   * Returns null on cache miss. Hash may be undefined for old entries stored
   * before integrity tracking was added.
   */
  async getUrlAndHash(
    lockfileHash: string,
    platform: string,
    arch: string,
  ): Promise<{ url: string; hash?: string } | null> {
    const key = depKey(lockfileHash, platform, arch);
    const url = await this.storage.getUrl(key, await this.resolveTtlMsOverride());
    if (!url) {
      logger.debug(`getUrlAndHash(${lockfileHash}): miss`, { platform, arch });
      return null;
    }
    await this.storage.touch(key);
    // Read companion hash file (best-effort — old entries won't have it)
    const hashKey = `deps/${platform}-${arch}/${lockfileHash}.hash`;
    const hashData = await this.storage.get(hashKey);
    const hash = hashData?.toString('utf-8') || undefined;
    logger.debug(`getUrlAndHash(${lockfileHash}): hit`, { platform, arch, hasHash: !!hash });
    return { url, hash };
  }

  /**
   * Get a pre-signed upload URL for direct agent-to-S3 upload.
   */
  async getUploadUrl(lockfileHash: string, platform: string, arch: string): Promise<string> {
    const key = depKey(lockfileHash, platform, arch);
    return this.storage.getUploadUrl(key);
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
    const key = depKey(lockfileHash, platform, arch);
    await this.storage.put(key, tarballData);
    logger.info(`store: ${tarballData.length} bytes`, { lockfileHash, platform, arch });
  }

  /**
   * Compute SHA-256 hash of a tarball buffer.
   * Used by build agents to compute the hash for depsHash protocol field.
   */
  static computeHash(data: Buffer): string {
    return sha256(data);
  }

  /** Remove a dep tarball from cache. */
  async remove(lockfileHash: string, platform: string, arch: string): Promise<boolean> {
    const key = depKey(lockfileHash, platform, arch);
    const removed = await this.storage.delete(key);
    logger.info(`remove(${lockfileHash}): ${removed ? 'removed' : 'not found'}`, {
      platform,
      arch,
    });
    return removed;
  }
}
