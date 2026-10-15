/**
 * Source-tarball cache over CacheStorage: the `.kici/` directory minus
 * `node_modules/` (packed by the agent's build job via `source-packer.ts`),
 * stored under the tarball's OWN content hash, with a pointer resolving an
 * org's workflow `contentHash` to it. Tarballs are platform-independent (raw
 * TypeScript source). Reads touch the TTL so active sources stay cached.
 *
 * Keys: `source/v2/{orgId}/{sourceTarDigest}.tar.gz` (immutable) and
 * `source/v2/{orgId}/{contentHash}.hash` (the pointer) — the `dep-cache.ts`
 * shape, for the same reasons:
 *
 * - **Content addressing** makes a mismatched pair unrepresentable: a key not
 *   derived from the bytes lets nothing a reader fetches be verified.
 * - **Org scoping** makes the key a tenant's key. `contentHash` alone is a
 *   property of a `.kici/` tree, so two repositories from the same `kici init`
 *   template, or a fork and its upstream, would share one object — a
 *   cross-tenant read on a multi-org orchestrator. The org is the tenant
 *   boundary the user cache scopes by too; within one org a shared key means
 *   byte-identical trees, so a monorepo or same-org fork keeps its warm cache.
 *
 * Retired `source/{contentHash}.tar.gz` objects are **not read**: only a
 * `compileSchemaVersion: 5` lock names one, and its `contentHash` covers the
 * entry file alone rather than the packed tree, so serving it would serve the
 * bug. A v6 lock cannot reach it (the bump moves every hash). The lazy TTL never
 * removes them (docs/operator/orchestrator/storage-layout.md § "Retired layouts").
 */

import { createLogger, sha256 } from '@kici-dev/shared';
import type { CacheStorage } from '../storage/types.js';

const logger = createLogger({ prefix: 'source-cache' });

/**
 * Named by its own hash, so every pair a reader observes is self-consistent and
 * the bytes at a key never change after a URL is signed for it.
 */
export function sourceTarballKey(orgId: string, sourceTarDigest: string): string {
  return `source/v2/${orgId}/${sourceTarDigest}.tar.gz`;
}

/**
 * The pointer from a workflow `contentHash` to its tarball's hash: the one
 * mutable object. A write replaces it wholesale (no half-written window), so
 * racing builders at worst leave the last-landed pointer, and both tarballs
 * stay valid and fetchable.
 */
export function sourcePointerKey(orgId: string, contentHash: string): string {
  return `source/v2/${orgId}/${contentHash}.hash`;
}

export class SourceCache {
  private readonly storage: CacheStorage;

  constructor(options: { storage: CacheStorage }) {
    this.storage = options.storage;
  }

  /** Resolves the pointer indirection (`getUrlAndDigest` reads it inline to touch it). */
  private async resolvePointer(orgId: string, contentHash: string): Promise<string | null> {
    const data = await this.storage.get(sourcePointerKey(orgId, contentHash));
    return data?.toString('utf-8').trim() || null;
  }

  /**
   * Both halves must exist: a pointer whose tarball aged out is a miss, or the
   * caller skips a rebuild and dispatches a URL that 404s on the agent.
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
   * A pre-signed download URL and the tarball's own digest. The pointer is
   * resolved FIRST and names both, so url and digest cannot disagree. Null on a
   * miss, including a pointer with no tarball (unverifiable, so not served).
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
    // Delegates so the url and the digest come from one pointer read — a
    // second copy is how the url and the digest drift apart again.
    const hit = await this.getUrlAndDigest(orgId, contentHash);
    return hit?.url ?? null;
  }

  /**
   * A pre-signed agent-to-storage upload URL, keyed by the tarball's OWN digest
   * (which the agent computes first), not the workflow `contentHash`.
   */
  async getUploadUrl(orgId: string, sourceTarDigest: string): Promise<string> {
    return this.storage.getUploadUrl(sourceTarballKey(orgId, sourceTarDigest));
  }

  /**
   * Publish the pointer to an uploaded tarball. Called only after the agent
   * confirms the upload, or a reader could follow it to a missing object.
   */
  async publishPointer(orgId: string, contentHash: string, sourceTarDigest: string): Promise<void> {
    await this.storage.put(sourcePointerKey(orgId, contentHash), sourceTarDigest);
    logger.info(`publishPointer(${contentHash}) -> ${sourceTarDigest.slice(0, 12)}`, { orgId });
  }

  /** Store a tarball and the pointer that names it. */
  async store(orgId: string, contentHash: string, tarball: Buffer | string): Promise<void> {
    const data = typeof tarball === 'string' ? Buffer.from(tarball) : tarball;
    const digest = SourceCache.computeDigest(data);
    // Order is load-bearing: the tarball must exist before any pointer names it.
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

  async remove(orgId: string, contentHash: string): Promise<boolean> {
    const digest = await this.resolvePointer(orgId, contentHash);
    // Drop the pointer first so nothing can resolve to a tarball being deleted.
    await this.storage.delete(sourcePointerKey(orgId, contentHash));
    const removed = digest ? await this.storage.delete(sourceTarballKey(orgId, digest)) : false;
    logger.info(`remove(${contentHash}): ${removed ? 'removed' : 'not found'}`, { orgId });
    return removed;
  }
}
