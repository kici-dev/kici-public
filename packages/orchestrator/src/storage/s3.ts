/**
 * S3-backed cache storage.
 *
 * Stores cached items in S3 with custom metadata headers for TTL tracking.
 * Uses AWS SDK v3 modular imports -- only loaded when S3 storage is configured.
 *
 * Metadata storage:
 *   x-amz-meta-created-at      -- ISO timestamp of creation
 *   x-amz-meta-last-accessed-at -- ISO timestamp of last access
 *
 * TTL is enforced lazily: expired items are deleted on access.
 * Pre-signed URLs are generated for getUrl() with 15-minute expiry.
 */

import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { CacheMetadata, CacheStorage } from './types.js';
import { createS3Client } from '@kici-dev/shared';

/** Pre-signed download URL expiry in seconds (15 minutes) */
const PRESIGNED_URL_EXPIRY_SECONDS = 900;

/** Pre-signed upload URL expiry in seconds (30 minutes -- uploads take longer) */
const UPLOAD_URL_EXPIRY_SECONDS = 1800;

export interface S3CacheStorageOptions {
  bucket: string;
  prefix: string;
  ttlMs: number;
  region?: string;
  /** Custom endpoint URL for S3-compatible services (e.g., SeaweedFS, LocalStack) */
  endpoint?: string;
  /**
   * Separate endpoint for pre-signed URLs (upload and download).
   * When set, pre-signed URLs use this endpoint instead of `endpoint`.
   * Useful when the orchestrator accesses S3 on localhost but agents
   * need a container-routable address (e.g., container DNS name).
   */
  externalEndpoint?: string;
  /**
   * Separate endpoint for the host-facing (CLI) pre-signed upload URL.
   * The CLI running `kici run remote` is on the developer's host, which may
   * reach the bucket at a different address than the orchestrator's own
   * `endpoint` (e.g. an orchestrator in a container uses the compose DNS name
   * while the host CLI uses localhost). When unset, `getInternalUploadUrl`
   * falls back to the internal `endpoint` client (current behavior).
   */
  uploadEndpoint?: string;
  /** Use path-style access instead of virtual-hosted-style (required for most S3-compatible services) */
  forcePathStyle?: boolean;
}

export class S3CacheStorage implements CacheStorage {
  private readonly client: S3Client;
  /** Separate client for pre-signed URL generation (uses externalEndpoint if configured). */
  private readonly presignClient: S3Client;
  /** Separate client for the host CLI's pre-signed upload URL (uses uploadEndpoint if configured). */
  private readonly uploadPresignClient: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly ttlMs: number;

  constructor(options: S3CacheStorageOptions) {
    this.bucket = options.bucket;
    this.prefix = options.prefix;
    this.ttlMs = options.ttlMs;
    this.client = createS3Client(options);

    // Create a separate S3Client for pre-signed URLs if externalEndpoint is set
    if (options.externalEndpoint) {
      this.presignClient = createS3Client({
        ...options,
        endpoint: options.externalEndpoint,
      });
    } else {
      this.presignClient = this.client;
    }

    // Host CLI uploads (getInternalUploadUrl) may need a different address than
    // the orchestrator's own endpoint. Falls back to `client` when unset.
    if (options.uploadEndpoint) {
      this.uploadPresignClient = createS3Client({
        ...options,
        endpoint: options.uploadEndpoint,
      });
    } else {
      this.uploadPresignClient = this.client;
    }
  }

  // -- Helpers --

  /** Build the full S3 object key from a cache key. */
  private objectKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  /** Check if metadata indicates an expired item, honoring a per-op TTL override. */
  private isExpired(meta: CacheMetadata, ttlMsOverride?: number): boolean {
    const ttl = ttlMsOverride ?? this.ttlMs;
    const lastAccessed = new Date(meta.lastAccessedAt).getTime();
    return Date.now() - lastAccessed > ttl;
  }

  /**
   * Read metadata from an S3 object's custom headers.
   * Returns null if the object doesn't exist (NoSuchKey/NotFound).
   */
  private async readMeta(key: string): Promise<CacheMetadata | null> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: this.objectKey(key),
        }),
      );

      const createdAt = head.Metadata?.['created-at'] ?? '';
      const lastAccessedAt = head.Metadata?.['last-accessed-at'] ?? '';

      if (!createdAt || !lastAccessedAt) return null;

      return { createdAt, lastAccessedAt };
    } catch (err: unknown) {
      if (this.isNotFoundError(err)) return null;
      throw err;
    }
  }

  /**
   * Update metadata on an S3 object by copying it to itself.
   * This is the standard S3 pattern for updating metadata without re-uploading data.
   */
  private async updateMeta(key: string, meta: CacheMetadata): Promise<void> {
    const objectKey = this.objectKey(key);
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        CopySource: `${this.bucket}/${objectKey}`,
        MetadataDirective: 'REPLACE',
        Metadata: {
          'created-at': meta.createdAt,
          'last-accessed-at': meta.lastAccessedAt,
        },
      }),
    );
  }

  /** Check if an error is a "not found" error (NoSuchKey, NotFound, 404). */
  private isNotFoundError(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;
    const name = (err as { name?: string }).name;
    if (name === 'NoSuchKey' || name === 'NotFound') return true;
    const code = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    return code === 404;
  }

  // -- CacheStorage interface --

  async put(key: string, data: Buffer | string): Promise<void> {
    const now = new Date().toISOString();
    const body = typeof data === 'string' ? Buffer.from(data) : data;

    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: this.objectKey(key),
        Body: body,
        Metadata: {
          'created-at': now,
          'last-accessed-at': now,
        },
      },
    });

    await upload.done();
  }

  async get(key: string, ttlMsOverride?: number): Promise<Buffer | null> {
    const meta = await this.readMeta(key);
    if (!meta) return null;

    if (this.isExpired(meta, ttlMsOverride)) {
      await this.deleteObject(key);
      return null;
    }

    let data: Buffer;
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.objectKey(key),
        }),
      );

      if (!response.Body) return null;

      data = Buffer.from(await response.Body.transformToByteArray());
    } catch (err: unknown) {
      if (this.isNotFoundError(err)) return null;
      throw err;
    }

    // Touch on read -- update lastAccessedAt (best-effort: don't lose
    // already-fetched data if the metadata update fails)
    try {
      meta.lastAccessedAt = new Date().toISOString();
      await this.updateMeta(key, meta);
    } catch {
      // Transient S3 errors or concurrent deletes shouldn't discard cached data
    }

    return data;
  }

  async has(key: string, ttlMsOverride?: number): Promise<boolean> {
    const meta = await this.readMeta(key);
    if (!meta) return false;

    if (this.isExpired(meta, ttlMsOverride)) {
      await this.deleteObject(key);
      return false;
    }

    return true;
  }

  async delete(key: string): Promise<boolean> {
    // HeadObject first to check existence (S3 delete is idempotent)
    const meta = await this.readMeta(key);
    const existed = meta !== null;

    await this.deleteObject(key);
    return existed;
  }

  async touch(key: string): Promise<void> {
    const meta = await this.readMeta(key);
    if (!meta) return;

    meta.lastAccessedAt = new Date().toISOString();
    await this.updateMeta(key, meta);
  }

  async getUrl(key: string, ttlMsOverride?: number): Promise<string | null> {
    const meta = await this.readMeta(key);
    if (!meta) return null;

    if (this.isExpired(meta, ttlMsOverride)) {
      await this.deleteObject(key);
      return null;
    }

    const url = await getSignedUrl(
      this.presignClient,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey(key),
      }),
      { expiresIn: PRESIGNED_URL_EXPIRY_SECONDS },
    );

    return url;
  }

  async getUploadUrl(key: string): Promise<string> {
    const objectKey = this.objectKey(key);
    return getSignedUrl(
      this.presignClient,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        // No Metadata in pre-signed URL -- two-phase approach per research Pitfall 1
        // Orchestrator will set metadata via initMeta() after agent confirms upload
      }),
      { expiresIn: UPLOAD_URL_EXPIRY_SECONDS },
    );
  }

  async getInternalUploadUrl(key: string): Promise<string> {
    const objectKey = this.objectKey(key);
    return getSignedUrl(
      this.uploadPresignClient,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
      }),
      { expiresIn: UPLOAD_URL_EXPIRY_SECONDS },
    );
  }

  async initMeta(key: string): Promise<void> {
    const objectKey = this.objectKey(key);
    const now = new Date().toISOString();
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        CopySource: `${this.bucket}/${objectKey}`,
        MetadataDirective: 'REPLACE',
        Metadata: {
          'created-at': now,
          'last-accessed-at': now,
        },
      }),
    );
  }

  async list(subPrefix: string): Promise<string[]> {
    const fullPrefix = this.objectKey(subPrefix);
    const items: { key: string; created: number }[] = [];
    let token: string | undefined;
    do {
      const resp = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: fullPrefix,
          ContinuationToken: token,
        }),
      );
      for (const obj of resp.Contents ?? []) {
        if (!obj.Key) continue;
        items.push({
          key: obj.Key.slice(this.prefix.length),
          created: obj.LastModified ? obj.LastModified.getTime() : 0,
        });
      }
      token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (token);
    items.sort((a, b) => b.created - a.created); // newest first
    return items.map((i) => i.key);
  }

  async getMetadata(key: string): Promise<CacheMetadata | null> {
    return this.readMeta(key);
  }

  async copy(srcKey: string, destKey: string): Promise<void> {
    const srcObj = this.objectKey(srcKey);
    const destObj = this.objectKey(destKey);
    const now = new Date().toISOString();
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: destObj,
        CopySource: `${this.bucket}/${srcObj}`,
        MetadataDirective: 'REPLACE',
        Metadata: { 'created-at': now, 'last-accessed-at': now },
      }),
    );
  }

  // -- Internal --

  /** Delete an S3 object. Idempotent (doesn't error if missing). */
  private async deleteObject(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: this.objectKey(key),
        }),
      );
    } catch (err: unknown) {
      if (!this.isNotFoundError(err)) throw err;
    }
  }
}
