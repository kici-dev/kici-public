/**
 * Source-tarball cache layer wrapping CacheStorage.
 *
 * Provides content-hash-keyed operations for customer-workflow source tarballs
 * (the `.kici/` directory minus `node_modules/`, packed by the agent's build
 * job via `source-packer.ts`). Tarballs are platform-independent: raw TypeScript
 * source files are identical across architectures. Refreshes TTL on reads
 * (touch-on-read) so actively used sources stay in cache longer.
 *
 * Cache key format: source/{contentHash}.tar.gz
 *
 * Replaces the former `BundleCache` / `bundles/{contentHash}.js` layout that
 * stored Rolldown-bundled `.compiled.mjs` artifacts — the new execution path
 * downloads the source tarball, extracts it, and imports the workflow entry
 * via the shared oxc-transform ESM loader hook.
 */

import { createLogger } from '@kici-dev/shared';
import type { CacheStorage } from '../storage/types.js';

const logger = createLogger({ prefix: 'source-cache' });

/** Cache key format: source/{contentHash}.tar.gz */
function sourceKey(contentHash: string): string {
  return `source/${contentHash}.tar.gz`;
}

export class SourceCache {
  private readonly storage: CacheStorage;

  constructor(options: { storage: CacheStorage }) {
    this.storage = options.storage;
  }

  async has(contentHash: string): Promise<boolean> {
    const key = sourceKey(contentHash);
    const exists = await this.storage.has(key);
    logger.debug(`has(${contentHash}): ${exists}`);
    return exists;
  }

  async get(contentHash: string): Promise<Buffer | null> {
    const key = sourceKey(contentHash);
    const data = await this.storage.get(key);
    if (data) {
      await this.storage.touch(key);
      logger.debug(`get(${contentHash}): hit (${data.length} bytes)`);
    } else {
      logger.debug(`get(${contentHash}): miss`);
    }
    return data;
  }

  async getUrl(contentHash: string): Promise<string | null> {
    const key = sourceKey(contentHash);
    const url = await this.storage.getUrl(key);
    if (url) {
      await this.storage.touch(key);
      logger.debug(`getUrl(${contentHash}): hit`);
    } else {
      logger.debug(`getUrl(${contentHash}): miss`);
    }
    return url;
  }

  async getUploadUrl(contentHash: string): Promise<string> {
    const key = sourceKey(contentHash);
    return this.storage.getUploadUrl(key);
  }

  async store(contentHash: string, tarball: Buffer | string): Promise<void> {
    const key = sourceKey(contentHash);
    await this.storage.put(key, tarball);
    const size = typeof tarball === 'string' ? Buffer.byteLength(tarball) : tarball.length;
    logger.info(`store(${contentHash}): stored (${size} bytes)`);
  }

  async remove(contentHash: string): Promise<boolean> {
    const key = sourceKey(contentHash);
    const removed = await this.storage.delete(key);
    logger.info(`remove(${contentHash}): ${removed ? 'removed' : 'not found'}`);
    return removed;
  }
}
