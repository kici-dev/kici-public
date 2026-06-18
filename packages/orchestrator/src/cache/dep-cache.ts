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

const logger = createLogger({ prefix: 'dep-cache' });

/** Default max tarball size: 500MB */
const DEFAULT_MAX_TARBALL_BYTES = 524_288_000;

/** Build cache key for dependency tarball: deps/{platform}-{arch}/{lockfileHash}.tar.gz */
function depKey(lockfileHash: string, platform: string, arch: string): string {
  return `deps/${platform}-${arch}/${lockfileHash}.tar.gz`;
}

export class DepCache {
  private readonly storage: CacheStorage;
  private readonly maxTarballBytes: number;

  constructor(options: { storage: CacheStorage; maxTarballBytes?: number }) {
    this.storage = options.storage;
    this.maxTarballBytes = options.maxTarballBytes ?? DEFAULT_MAX_TARBALL_BYTES;
  }

  /** Check if a dep tarball exists in cache. */
  async has(lockfileHash: string, platform: string, arch: string): Promise<boolean> {
    const key = depKey(lockfileHash, platform, arch);
    const exists = await this.storage.has(key);
    logger.debug(`has(${lockfileHash}): ${exists}`, { platform, arch });
    return exists;
  }

  /**
   * Get a pre-signed download URL for the dep tarball (for agent delivery).
   * Refreshes TTL on hit.
   */
  async getUrl(lockfileHash: string, platform: string, arch: string): Promise<string | null> {
    const key = depKey(lockfileHash, platform, arch);
    const url = await this.storage.getUrl(key);
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
    const url = await this.storage.getUrl(key);
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
    if (tarballData.length > this.maxTarballBytes) {
      throw new Error(
        `Dep tarball exceeds max size: ${tarballData.length} bytes > ${this.maxTarballBytes} bytes limit`,
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
