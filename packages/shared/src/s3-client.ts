/**
 * Shared S3 client construction helper.
 *
 * Avoids duplicating the region/endpoint/forcePathStyle config pattern
 * across S3LogStorage, S3CacheStorage, the cold-store framework, and any
 * future S3 consumers.
 *
 * The exported `SharedS3Config` is the generic, TTL-free base config —
 * domain-specific consumers extend it (e.g., adding `ttlMs` + discriminant
 * for cache-storage variants).
 */
import { S3Client, type S3ClientConfig as AwsS3ClientConfig } from '@aws-sdk/client-s3';

/**
 * Generic S3-compatible configuration shared across KiCI consumers.
 *
 * Callers layer domain-specific fields on top (e.g. orchestrator's
 * CacheStorageConfig adds `ttlMs`, cold-store's ColdStoreConfig adds
 * table-level tuning).
 */
export interface SharedS3Config {
  bucket: string;
  prefix: string;
  region?: string;
  /** Custom endpoint URL for S3-compatible services (e.g., SeaweedFS, LocalStack) */
  endpoint?: string;
  /**
   * Separate endpoint for pre-signed URLs (upload and download).
   * When set, pre-signed URLs use this endpoint instead of `endpoint`.
   * Useful when the server accesses S3 internally but clients need a
   * different address (e.g., container-routable DNS name).
   */
  externalEndpoint?: string;
  /** Use path-style access (required for most S3-compatible services). Default: false */
  forcePathStyle?: boolean;
}

export interface CreateS3ClientOptions {
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
}

export function createS3Client(options: CreateS3ClientOptions): S3Client {
  const config: AwsS3ClientConfig = {
    // The AWS SDK v3 default (`WHEN_SUPPORTED`) injects an `x-amz-checksum-crc32`
    // header into every PutObject — including pre-signed PUT URLs, where the
    // checksum is computed at presign time over an unknown body. The client then
    // uploads a different body, so strict S3-compatible stores (SeaweedFS,
    // MinIO, Cloudflare R2) reject the PUT with 400 BadDigest. AWS S3 itself
    // tolerates the mismatch, which is why this only bites non-AWS backends.
    // `WHEN_REQUIRED` adds a checksum only for operations that mandate one, so
    // pre-signed uploads/downloads work across every supported backend.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  };
  if (options.region) {
    config.region = options.region;
  }
  if (options.endpoint) {
    config.endpoint = options.endpoint;
  }
  if (options.forcePathStyle !== undefined) {
    config.forcePathStyle = options.forcePathStyle;
  }
  return new S3Client(config);
}
