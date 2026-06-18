/**
 * S3-backed log storage.
 *
 * Stores execution logs in S3. No TTL -- logs persist indefinitely.
 *
 * Implementation notes:
 * - append() reads existing content + concatenates + puts back (acceptable
 *   for the sequential step model where max ~10MB per step)
 * - read() uses Range header for cursor-based pagination
 * - exists() uses HeadObject
 * - list() uses ListObjectsV2 with prefix
 *
 * Uses AWS SDK v3 modular imports -- only loaded when S3 storage is configured.
 */

import {
  type S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import type { LogReadOptions, LogReadResult, LogStorage } from './log-storage.js';
import { createS3Client } from '@kici-dev/shared';

interface S3LogStorageOptions {
  bucket: string;
  prefix: string;
  region?: string;
  /** Custom endpoint URL for S3-compatible services (e.g., SeaweedFS, LocalStack) */
  endpoint?: string;
  /** Use path-style access instead of virtual-hosted-style (required for most S3-compatible services) */
  forcePathStyle?: boolean;
}

export class S3LogStorage implements LogStorage {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(options: S3LogStorageOptions) {
    this.bucket = options.bucket;
    this.prefix = options.prefix;
    this.client = createS3Client(options);
  }

  // -- Helpers --

  /** Build the full S3 object key from a log path. */
  private objectKey(path: string): string {
    return `${this.prefix}${path}`;
  }

  /** Check if an error is a "not found" error (NoSuchKey, NotFound, 404). */
  private isNotFoundError(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;
    const name = (err as { name?: string }).name;
    if (name === 'NoSuchKey' || name === 'NotFound') return true;
    const code = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    return code === 404;
  }

  /** Read the full content of an S3 object as a string. Returns null if not found. */
  private async getContent(key: string): Promise<string | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );

      if (!response.Body) return null;

      const bytes = await response.Body.transformToByteArray();
      return Buffer.from(bytes).toString('utf-8');
    } catch (err: unknown) {
      if (this.isNotFoundError(err)) return null;
      throw err;
    }
  }

  // -- LogStorage interface --

  async append(path: string, data: string): Promise<void> {
    const key = this.objectKey(path);

    // Read existing content (if any) and append new data
    const existing = await this.getContent(key);
    const newContent = existing !== null ? existing + data : data;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: Buffer.from(newContent, 'utf-8'),
        ContentType: 'application/x-ndjson',
      }),
    );
  }

  async read(path: string, options?: LogReadOptions): Promise<LogReadResult> {
    const key = this.objectKey(path);
    const cursor = options?.cursor ?? 0;
    const limit = options?.limit;

    // First, get the object size via HEAD
    let totalSize: number;
    try {
      const head = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      totalSize = head.ContentLength ?? 0;
    } catch (err: unknown) {
      if (this.isNotFoundError(err)) {
        return { data: '', cursor: 0, complete: true };
      }
      throw err;
    }

    if (cursor >= totalSize) {
      return { data: '', cursor: totalSize, complete: true };
    }

    // Build Range header for partial read
    const end = limit !== undefined ? Math.min(cursor + limit - 1, totalSize - 1) : totalSize - 1;
    const rangeHeader = `bytes=${cursor}-${end}`;

    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Range: rangeHeader,
        }),
      );

      if (!response.Body) {
        return { data: '', cursor, complete: true };
      }

      const content = Buffer.from(await response.Body.transformToByteArray()).toString('utf-8');
      const newCursor = cursor + content.length;

      return {
        data: content,
        cursor: newCursor,
        complete: newCursor >= totalSize,
      };
    } catch (err: unknown) {
      if (this.isNotFoundError(err)) {
        return { data: '', cursor: 0, complete: true };
      }
      throw err;
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: this.objectKey(path),
        }),
      );
      return true;
    } catch (err: unknown) {
      if (this.isNotFoundError(err)) return false;
      throw err;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const fullPrefix = this.objectKey(prefix);
    const results: string[] = [];
    let continuationToken: string | undefined;

    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: fullPrefix,
          ContinuationToken: continuationToken,
        }),
      );

      if (response.Contents) {
        for (const obj of response.Contents) {
          if (obj.Key) {
            // Return path relative to the storage prefix (not the full S3 key)
            const relativePath = obj.Key.startsWith(this.prefix)
              ? obj.Key.slice(this.prefix.length)
              : obj.Key;
            results.push(relativePath);
          }
        }
      }

      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);

    return results.sort();
  }
}
