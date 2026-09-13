/**
 * Source-tarball cache layer wrapping CacheStorage.
 *
 * Stores customer-workflow source tarballs — the `.kici/` directory minus
 * `node_modules/`, packed by the agent's build job via `source-packer.ts` —
 * under the tarball's OWN content hash, with a small pointer resolving an org's
 * workflow `contentHash` to that hash. Tarballs are platform-independent: raw
 * TypeScript source is identical across architectures. Refreshes TTL on reads
 * (touch-on-read) so actively used sources stay in cache longer.
 *
 * Keys: `source/v2/{orgId}/{sourceTarDigest}.tar.gz` (immutable) and
 * `source/v2/{orgId}/{contentHash}.hash` (the pointer) — the shape `dep-cache.ts`
 * already uses, for the same reasons — content addressing and org scoping.
 *
 * **Content addressing** makes a mismatched pair unrepresentable. At
 * `source/{contentHash}.tar.gz` the object's key was derived from something
 * other than its bytes, so nothing a reader fetched could be verified against
 * anything, and the agent restored whatever the signed URL returned.
 *
 * **Org scoping** makes the key a tenant's key. `contentHash` alone is a
 * property of a `.kici/` tree, so two repositories scaffolded from the same
 * `kici init` template — or a fork and its upstream — produced one object, and
 * whichever built first won for the life of that object. On an orchestrator
 * serving more than one org that is a cross-tenant read of `.kici/` contents.
 * The org is the tenant boundary and the segment the user cache already scopes
 * by; inside one org, sharing a key now means the two trees are byte-identical,
 * so a monorepo or a same-org fork keeps its warm cache and pays nothing.
 *
 * Legacy `source/{contentHash}.tar.gz` objects are **not read**. Only a
 * `compileSchemaVersion: 5` lock can name one, and that `contentHash` covers
 * the workflow entry file alone rather than the tree the tarball holds — the
 * defect this layout closes — so serving it would serve the bug. For a v6 lock
 * the fallback is unreachable anyway, since the schema bump moves every hash.
 * Old objects are orphaned and aged out by the normal cache TTL.
 */

import { createLogger, sha256 } from '@kici-dev/shared';
import type { CacheStorage } from '../storage/types.js';

const logger = createLogger({ prefix: 'source-cache' });

/**
 * Cache key for a source tarball, addressed by the tarball's OWN content hash:
 * `source/v2/{orgId}/{sourceTarDigest}.tar.gz`.
 *
 * Naming the object by its own hash means every pair a reader can observe is
 * self-consistent, and the bytes at a given key can never change after a URL is
 * signed for it.
 */
export function sourceTarballKey(orgId: string, sourceTarDigest: string): string {
  return `source/v2/${orgId}/${sourceTarDigest}.tar.gz`;
}

/**
 * Cache key for the pointer that resolves a workflow `contentHash` to the
 * content hash of the tarball built from it: `source/v2/{orgId}/{contentHash}.hash`.
 *
 * This is the one mutable object in the scheme. A concurrent write replaces a
 * pointer wholesale — there is no half-written window — so the worst a racing
 * pair of builders can do is leave whichever pointer landed last, and both
 * tarballs stay valid and fetchable.
 */
export function sourcePointerKey(orgId: string, contentHash: string): string {
  return `source/v2/${orgId}/${contentHash}.hash`;
}

export class SourceCache {
  private readonly storage: CacheStorage;

  constructor(options: { storage: CacheStorage }) {
    this.storage = options.storage;
  }

  /** The single place the pointer indirection is read. */
  private async resolvePointer(orgId: string, contentHash: string): Promise<string | null> {
    const data = await this.storage.get(sourcePointerKey(orgId, contentHash));
    return data?.toString('utf-8').trim() || null;
  }

  /**
   * Whether a source tarball for this org's `contentHash` exists.
   *
   * Both halves must be present: a pointer whose tarball has aged out is a
   * miss, not a hit, or the caller skips a rebuild and dispatches a URL that
   * 404s on the agent.
   */
  async has(orgId: string, contentHash: string): Promise<boolean> {
    const digest = await this.resolvePointer(orgId, contentHash);
    if (!digest) {
      logger.debug(`has(${contentHash}): false (no pointer)`, { orgId });
      return false;
    }
    const exists = await this.storage.has(sourceTarballKey(orgId, digest));
    logger.debug(`has(${contentHash}): ${exists}`, { orgId });
    return exists;
  }

  async get(orgId: string, contentHash: string): Promise<Buffer | null> {
    const digest = await this.resolvePointer(orgId, contentHash);
    if (!digest) {
      logger.debug(`get(${contentHash}): miss (no pointer)`, { orgId });
      return null;
    }
    const key = sourceTarballKey(orgId, digest);
    const data = await this.storage.get(key);
    if (data) {
      await this.storage.touch(key);
      logger.debug(`get(${contentHash}): hit (${data.length} bytes)`, { orgId });
    } else {
      logger.debug(`get(${contentHash}): miss (dangling pointer)`, { orgId });
    }
    return data;
  }

  /**
   * A pre-signed download URL and the tarball's own digest.
   *
   * The pointer is resolved FIRST: it names the content hash, which is also the
   * tarball's key, so the url and the digest returned here are read from a
   * single source of truth and cannot disagree. Returns null on a miss —
   * including a pointer with no tarball behind it, which is unverifiable and so
   * is deliberately not served.
   */
  async getUrlAndDigest(
    orgId: string,
    contentHash: string,
  ): Promise<{ url: string; digest: string } | null> {
    const pointerKey = sourcePointerKey(orgId, contentHash);
    const pointerData = await this.storage.get(pointerKey);
    const digest = pointerData?.toString('utf-8').trim() || null;
    if (!digest) {
      logger.debug(`getUrlAndDigest(${contentHash}): miss (no pointer)`, { orgId });
      return null;
    }
    const key = sourceTarballKey(orgId, digest);
    const url = await this.storage.getUrl(key);
    if (!url) {
      // A pointer whose tarball aged out first — they expire independently.
      logger.debug(`getUrlAndDigest(${contentHash}): miss (dangling pointer)`, { orgId });
      return null;
    }
    // Touch both so a live entry's two halves age together.
    await this.storage.touch(key);
    await this.storage.touch(pointerKey);
    logger.debug(`getUrlAndDigest(${contentHash}): hit`, { orgId });
    return { url, digest };
  }

  async getUrl(orgId: string, contentHash: string): Promise<string | null> {
    // Delegates so the pointer indirection lives in exactly one place — a
    // second copy is how the url and the digest drift apart again.
    const hit = await this.getUrlAndDigest(orgId, contentHash);
    return hit?.url ?? null;
  }

  /**
   * A pre-signed upload URL for direct agent-to-storage upload.
   *
   * Takes the tarball's OWN digest, not the workflow `contentHash`: the agent
   * computes it before asking for a URL, and the object is named by it.
   */
  async getUploadUrl(orgId: string, sourceTarDigest: string): Promise<string> {
    return this.storage.getUploadUrl(sourceTarballKey(orgId, sourceTarDigest));
  }

  /**
   * Publish the pointer that makes an uploaded tarball discoverable by
   * `contentHash`. Called only after the agent confirms its upload completed —
   * publishing before the bytes land would let a reader follow the pointer to a
   * missing object.
   */
  async publishPointer(orgId: string, contentHash: string, sourceTarDigest: string): Promise<void> {
    await this.storage.put(sourcePointerKey(orgId, contentHash), sourceTarDigest);
    logger.info(`publishPointer(${contentHash}) -> ${sourceTarDigest.slice(0, 12)}`, { orgId });
  }

  /** Store a tarball and the pointer that names it. */
  async store(orgId: string, contentHash: string, tarball: Buffer | string): Promise<void> {
    const data = typeof tarball === 'string' ? Buffer.from(tarball) : tarball;
    const digest = SourceCache.computeDigest(data);
    // Order is load-bearing: the tarball must exist before any pointer names
    // it, or a reader can follow a pointer to an object that is not there yet.
    await this.storage.put(sourceTarballKey(orgId, digest), data);
    await this.storage.put(sourcePointerKey(orgId, contentHash), digest);
    logger.info(`store(${contentHash}): stored (${data.length} bytes)`, {
      orgId,
      digest: digest.slice(0, 12),
    });
  }

  /** SHA-256 of a tarball's bytes. The agent computes the same value. */
  static computeDigest(data: Buffer): string {
    return sha256(data);
  }

  /** Remove a source tarball and its pointer. */
  async remove(orgId: string, contentHash: string): Promise<boolean> {
    const digest = await this.resolvePointer(orgId, contentHash);
    // Drop the pointer first so nothing can resolve to a tarball being deleted.
    await this.storage.delete(sourcePointerKey(orgId, contentHash));
    const removed = digest ? await this.storage.delete(sourceTarballKey(orgId, digest)) : false;
    logger.info(`remove(${contentHash}): ${removed ? 'removed' : 'not found'}`, { orgId });
    return removed;
  }
}
