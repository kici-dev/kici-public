/**
 * Pluggable cache storage for the orchestrator (compiled workflow bundles,
 * etc.). Implementations handle TTL-based expiry via lastAccessedAt.
 *
 * Backends: `S3CacheStorage` (production / multi-host) and
 * `FilesystemCacheStorage` (single-host / test sandboxes).
 */

/** Metadata tracked alongside each cached item; drives TTL-based expiry. */
export interface CacheMetadata {
  /** ISO timestamp of the first store. */
  createdAt: string;
  /** ISO timestamp of the last access (read or touch). */
  lastAccessedAt: string;
}

/**
 * Pluggable cache storage. An item is expired when
 * (now - lastAccessedAt) > ttlMs; expired items are cleaned up lazily on access.
 */
export interface CacheStorage {
  /** Store a value; overwrites an existing key. */
  put(key: string, data: Buffer | string): Promise<void>;

  /**
   * Retrieve a value; null if not found or expired. `ttlMsOverride` replaces
   * the backend's constructor-time TTL for this call, so a per-org cache TTL
   * overrides the cluster-wide default without re-constructing the backend.
   */
  get(key: string, ttlMsOverride?: number): Promise<Buffer | null>;

  /**
   * Whether a key exists and is not expired, without retrieving data.
   * `ttlMsOverride`: see `get`.
   */
  has(key: string, ttlMsOverride?: number): Promise<boolean>;

  /** Delete a key. Returns true if the key existed (even if expired). */
  delete(key: string): Promise<boolean>;

  /** Update lastAccessedAt to now, refreshing the TTL. No-op if key doesn't exist. */
  touch(key: string): Promise<void>;

  /**
   * A pre-signed download URL; null if not found or expired.
   * `ttlMsOverride`: see `get`.
   */
  getUrl(key: string, ttlMsOverride?: number): Promise<string | null>;

  /**
   * How long, in seconds, a `getUrl` link authorizes a download before its
   * signature expires. This is the signature expiry, NOT the
   * artifact-retention TTL; consumers that render a `getUrl` link (e.g. the
   * dashboard artifacts panel) use it to refresh the link in time.
   */
  presignedGetTtlSeconds(): number;

  /**
   * A pre-signed PUT URL for direct agent upload, signed with the external
   * (container-routable) endpoint when configured.
   */
  getUploadUrl(key: string): Promise<string>;

  /**
   * The pre-signed PUT URL a developer machine running `kici run remote`
   * uploads the overlay to. The S3 backend signs it with
   * `KICI_STORAGE_UPLOAD_ENDPOINT`, else the agent-facing
   * `KICI_STORAGE_EXTERNAL_ENDPOINT`, else `KICI_STORAGE_ENDPOINT`.
   */
  getInternalUploadUrl(key: string): Promise<string>;

  /**
   * Set created-at and last-accessed-at to now on an object uploaded via
   * pre-signed URL. A pre-signed PUT cannot carry custom metadata, so call this
   * after the agent confirms the upload via cache.upload.complete.
   */
  initMeta(key: string): Promise<void>;

  /**
   * Full cache keys (without the storage prefix) under a sub-prefix, newest
   * first by createdAt/last-modified metadata (lexicographic when metadata is
   * unavailable); empty when nothing matches.
   */
  list(subPrefix: string): Promise<string[]>;

  /** Server-side copy between keys (used for atomic temp -> final commit). */
  copy(srcKey: string, destKey: string): Promise<void>;

  /**
   * The stored metadata, read WITHOUT refreshing lastAccessedAt or any
   * TTL-expiry side effect; null when the key is missing or has no metadata.
   * Quota eviction uses it to order candidates by access recency.
   */
  getMetadata(key: string): Promise<CacheMetadata | null>;

  /**
   * Byte size of the stored object, or null when missing. A pure stat (no
   * metadata write, no TTL/last-accessed side effect), used to verify an
   * artifact's real size server-side instead of trusting the agent's value.
   */
  getObjectSize(key: string): Promise<number | null>;
}

import type { S3StaticCredentials, SharedS3Config } from '@kici-dev/shared';

/** S3 backend config: `SharedS3Config` plus the cache-specific `ttlMs`. */
export type S3CacheStorageConfig = SharedS3Config & {
  type: 's3';
  ttlMs: number;
  /** Host-facing pre-signed upload endpoint (see S3CacheStorageOptions.uploadEndpoint). */
  uploadEndpoint?: string;
  /** Explicit credentials (see S3CacheStorageOptions.credentials). */
  credentials?: S3StaticCredentials;
  /** Shared-config profile (see S3CacheStorageOptions.profile). */
  profile?: string;
};

/**
 * Filesystem backend config. Stores blobs under `basePath` and mints
 * HMAC-signed `http://baseUrl<routePrefix>...` URLs that the orchestrator's
 * `/api/v1/cache/blob/*` route verifies before serving. For single-host / test
 * sandboxes.
 */
export interface FilesystemCacheStorageConfig {
  type: 'filesystem';
  /** Absolute path to the cache root directory. */
  basePath: string;
  /** Item TTL in milliseconds. */
  ttlMs: number;
  /** Base URL the agent uses to reach the orchestrator. */
  baseUrl: string;
  /** Per-process HMAC secret used to sign URLs. */
  signingSecret: string;
}

/** Cache storage backend config, discriminated on `type`. */
export type CacheStorageConfig = S3CacheStorageConfig | FilesystemCacheStorageConfig;
