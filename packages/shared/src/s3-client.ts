/** One S3 client builder for S3LogStorage, S3CacheStorage and the cold-store framework. */
import { S3Client, type S3ClientConfig as AwsS3ClientConfig } from '@aws-sdk/client-s3';

/**
 * TTL-free base S3 config; consumers extend it (CacheStorageConfig adds `ttlMs`,
 * ColdStoreConfig adds table-level tuning).
 */
export interface SharedS3Config {
  bucket: string;
  prefix: string;
  region?: string;
  /** For S3-compatible services (e.g., SeaweedFS, LocalStack). */
  endpoint?: string;
  /**
   * Endpoint for pre-signed upload and download URLs, instead of `endpoint`, for
   * clients that reach S3 at a different address than the server (e.g. a
   * container-routable DNS name).
   */
  externalEndpoint?: string;
  /** Use path-style access (required for most S3-compatible services). Default: false */
  forcePathStyle?: boolean;
}

/** Static S3 credentials, as the `AWS_ACCESS_KEY_ID` family of variables holds them. */
export interface S3StaticCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface CreateS3ClientOptions {
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  /** Explicit credentials. When unset, the SDK default credential chain applies. */
  credentials?: S3StaticCredentials;
  /** The shared-config profile the default credential chain reads. */
  profile?: string;
}

export function createS3Client(options: CreateS3ClientOptions): S3Client {
  const config: AwsS3ClientConfig = {
    // The SDK v3 default (`WHEN_SUPPORTED`) puts an `x-amz-checksum-crc32` on
    // every PutObject, pre-signed PUTs included, computed at presign time over an
    // unknown body. Strict stores (SeaweedFS, MinIO, Cloudflare R2) then reject
    // the upload with 400 BadDigest; AWS S3 tolerates it. `WHEN_REQUIRED`
    // checksums only operations that mandate one.
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
  if (options.credentials) {
    config.credentials = options.credentials;
  }
  if (options.profile) {
    config.profile = options.profile;
  }
  return new S3Client(config);
}
