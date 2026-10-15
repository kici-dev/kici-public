/**
 * Dependency cache over CacheStorage (the same S3 bucket as SourceCache).
 * Tarballs live under their own content hash, with a small pointer resolving
 * lockfileHash + platform + arch to it. Reads refresh TTL (touch-on-read).
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
 * Cache key for a dependency tarball, addressed by its OWN content hash:
 * `deps/{platform}-{arch}/{depsHash}.tar.gz`.
 *
 * Content-addressing makes a mismatched pair unrepresentable. Under a
 * lockfile-derived name, concurrent builders sharing lockfile + platform + arch
 * could leave one's `.tar.gz` and the other's `.hash`, and the reader failed
 * verification durably. Named by its own hash, every observable pair is
 * self-consistent and a key's bytes never change after a URL is signed for it.
 */
export function depTarballKey(depsHash: string, platform: string, arch: string): string {
  return `deps/${platform}-${arch}/${depsHash}.tar.gz`;
}

/**
 * Cache key for the pointer that resolves a lockfile to the content hash of the
 * tarball built from it: `deps/{platform}-{arch}/{lockfileHash}.hash`, or
 * `…/{lockfileHash}-{siblingsDigest}.hash` when the lock carries one.
 *
 * `siblingsDigest` is keyed because the tarball carries in-repo `workspace:`
 * siblings WITH their built output, and editing a sibling moves no lock file —
 * a `lockfileHash`-only key restored a stale sibling build over the fresh clone.
 * A lock with no in-repo sibling carries no digest, so existing pointers stay live.
 *
 * The one mutable object in the scheme. A write replaces the pointer wholesale
 * (never half-written), so racing builders at worst leave whichever landed
 * last, and both tarballs stay valid and fetchable.
 */
export function depPointerKey(
  lockfileHash: string,
  platform: string,
  arch: string,
  siblingsDigest?: string,
): string {
  const name = siblingsDigest ? `${lockfileHash}-${siblingsDigest}` : lockfileHash;
  return `deps/${platform}-${arch}/${name}.hash`;
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
   * Per-operation TTL override (ms) from `cluster_settings.cache_ttl_days`, so
   * an operator's change takes effect on the next lookup. `undefined` when no
   * reader is wired, so the backend uses its own configured TTL.
   */
  private async resolveTtlMsOverride(): Promise<number | undefined> {
    if (!this.clusterSettings) return undefined;
    const days = await this.clusterSettings.getNumber('cache_ttl_days', this.cacheTtlDaysFallback);
    return days * MS_PER_DAY;
  }

  /** Lockfile → tarball content hash, or null when no pointer exists. */
  private async resolvePointer(
    lockfileHash: string,
    platform: string,
    arch: string,
    ttlMsOverride: number | undefined,
    siblingsDigest?: string,
  ): Promise<string | null> {
    const data = await this.storage.get(
      depPointerKey(lockfileHash, platform, arch, siblingsDigest),
      ttlMsOverride,
    );
    return data?.toString('utf-8').trim() || null;
  }

  /**
   * Both halves must be present: a pointer whose tarball aged out is a miss, or
   * the caller skips a rebuild and dispatches a URL that 404s.
   */
  async has(
    lockfileHash: string,
    platform: string,
    arch: string,
    siblingsDigest?: string,
  ): Promise<boolean> {
    const ttlMsOverride = await this.resolveTtlMsOverride();
    const depsHash = await this.resolvePointer(
      lockfileHash,
      platform,
      arch,
      ttlMsOverride,
      siblingsDigest,
    );
    if (!depsHash) {
      logger.debug(`has(${lockfileHash}): false (no pointer)`, { platform, arch });
      return false;
    }
    const exists = await this.storage.has(depTarballKey(depsHash, platform, arch), ttlMsOverride);
    logger.debug(`has(${lockfileHash}): ${exists}`, { platform, arch });
    return exists;
  }

  /** Pre-signed download URL for agent delivery. Refreshes TTL on hit. */
  async getUrl(
    lockfileHash: string,
    platform: string,
    arch: string,
    siblingsDigest?: string,
  ): Promise<string | null> {
    // Delegates: a second copy of the indirection lets url and hash drift apart.
    const hit = await this.getUrlAndHash(lockfileHash, platform, arch, siblingsDigest);
    return hit?.url ?? null;
  }

  /**
   * Pre-signed download URL plus tarball content hash; null on a miss,
   * including an entry with no pointer (unverifiable, so never served).
   */
  async getUrlAndHash(
    lockfileHash: string,
    platform: string,
    arch: string,
    siblingsDigest?: string,
  ): Promise<{ url: string; hash?: string } | null> {
    const ttlMsOverride = await this.resolveTtlMsOverride();

    // Pointer FIRST: its content hash is also the tarball's key, so url and
    // hash come from one source of truth and cannot disagree.
    const pointerKey = depPointerKey(lockfileHash, platform, arch, siblingsDigest);
    const pointerData = await this.storage.get(pointerKey, ttlMsOverride);
    const hash = pointerData?.toString('utf-8').trim() || undefined;
    if (!hash) {
      logger.debug(`getUrlAndHash(${lockfileHash}): miss (no pointer)`, { platform, arch });
      return null;
    }

    const key = depTarballKey(hash, platform, arch);
    const url = await this.storage.getUrl(key, ttlMsOverride);
    if (!url) {
      // Dangling: the halves expire independently. A miss makes the caller
      // rebuild rather than dispatch a URL that 404s on the agent.
      logger.debug(`getUrlAndHash(${lockfileHash}): miss (dangling pointer)`, { platform, arch });
      return null;
    }
    // Touch both so a live entry's two halves age together.
    await this.storage.touch(key);
    await this.storage.touch(pointerKey);
    logger.debug(`getUrlAndHash(${lockfileHash}): hit`, { platform, arch, hasHash: true });
    return { url, hash };
  }

  /** Pre-signed URL for direct agent-to-S3 upload. */
  async getUploadUrl(depsHash: string, platform: string, arch: string): Promise<string> {
    // The tarball's OWN hash, not the lockfile hash: the agent computes it
    // before asking, and the object is named by it.
    return this.storage.getUploadUrl(depTarballKey(depsHash, platform, arch));
  }

  /**
   * Make an uploaded tarball discoverable by lockfile. Called only after the
   * agent confirms its upload, or a reader could follow the pointer to nothing.
   */
  async publishPointer(
    lockfileHash: string,
    platform: string,
    arch: string,
    depsHash: string,
    siblingsDigest?: string,
  ): Promise<void> {
    await this.storage.put(depPointerKey(lockfileHash, platform, arch, siblingsDigest), depsHash);
    logger.info(`publishPointer(${lockfileHash}) -> ${depsHash.slice(0, 12)}`, { platform, arch });
  }

  /** Throws when the tarball exceeds the max size. */
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
    // Tarball before pointer, or a reader can follow a pointer to nothing.
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
   * Compute SHA-256 hash of a tarball buffer: the `depsHash` that `store()`
   * keys and logs the tarball under.
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
