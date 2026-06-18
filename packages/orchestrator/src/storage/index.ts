/**
 * Cache storage module.
 *
 * Pluggable storage backends:
 *   - S3CacheStorage         — production / multi-host
 *   - FilesystemCacheStorage — single-host / E2E sandbox
 *
 * Use createCacheStorage() to instantiate from a discriminated config.
 */

export type {
  CacheStorage,
  CacheStorageConfig,
  CacheMetadata,
  S3CacheStorageConfig,
  FilesystemCacheStorageConfig,
} from './types.js';
export { S3CacheStorage } from './s3.js';
export { FilesystemCacheStorage } from './filesystem.js';
export { signToken, verifyToken, generateSigningSecret } from './sign-url.js';
export type { SignedMethod, SignedToken, VerifyResult } from './sign-url.js';

import type { CacheStorage, CacheStorageConfig } from './types.js';
import { S3CacheStorage } from './s3.js';
import { FilesystemCacheStorage } from './filesystem.js';

/**
 * Create a cache storage backend from configuration.
 */
export function createCacheStorage(config: CacheStorageConfig): CacheStorage {
  if (config.type === 's3') {
    return new S3CacheStorage({
      bucket: config.bucket,
      prefix: config.prefix,
      ttlMs: config.ttlMs,
      region: config.region,
      endpoint: config.endpoint,
      externalEndpoint: config.externalEndpoint,
      uploadEndpoint: config.uploadEndpoint,
      forcePathStyle: config.forcePathStyle,
    });
  }
  if (config.type === 'filesystem') {
    return new FilesystemCacheStorage({
      basePath: config.basePath,
      ttlMs: config.ttlMs,
      baseUrl: config.baseUrl,
      signingSecret: config.signingSecret,
    });
  }
  throw new Error(`Unknown cache storage type: ${(config as { type: string }).type}`);
}
