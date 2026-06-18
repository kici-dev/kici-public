/**
 * Cache storage abstraction for the orchestrator.
 *
 * Provides a pluggable backend interface for storing and retrieving
 * cached data (compiled workflow bundles, etc.). Implementations
 * must handle TTL-based expiry via lastAccessedAt timestamps.
 *
 * Backends:
 *   - `S3CacheStorage` for production / multi-host deployments
 *   - `FilesystemCacheStorage` for single-host / E2E sandboxes
 */

/**
 * Metadata tracked alongside each cached item.
 * Used for TTL-based expiry (based on lastAccessedAt).
 */
export interface CacheMetadata {
  /** ISO timestamp of when the item was first stored */
  createdAt: string;
  /** ISO timestamp of when the item was last accessed (read or touched) */
  lastAccessedAt: string;
}

/**
 * Pluggable cache storage interface.
 *
 * All operations are async. Implementations must handle TTL-based expiry:
 * an item is considered expired when (now - lastAccessedAt) > ttlMs.
 * Expired items are cleaned up lazily on access.
 */
export interface CacheStorage {
  /** Store a value under the given key. Overwrites if key already exists. */
  put(key: string, data: Buffer | string): Promise<void>;

  /**
   * Retrieve a value by key. Returns null if not found or expired.
   * `ttlMsOverride` applies a per-operation TTL instead of the backend's
   * constructor-time default (lets per-org cache TTLs override the
   * cluster-wide default without re-constructing the backend).
   */
  get(key: string, ttlMsOverride?: number): Promise<Buffer | null>;

  /**
   * Check if a key exists and is not expired, without retrieving data.
   * `ttlMsOverride` applies a per-operation TTL (see `get`).
   */
  has(key: string, ttlMsOverride?: number): Promise<boolean>;

  /** Delete a key. Returns true if the key existed (even if expired). */
  delete(key: string): Promise<boolean>;

  /** Update lastAccessedAt to now, refreshing the TTL. No-op if key doesn't exist. */
  touch(key: string): Promise<void>;

  /**
   * Get a pre-signed download URL for the cached item.
   * Returns null if not found or expired.
   * `ttlMsOverride` applies a per-operation TTL (see `get`).
   */
  getUrl(key: string, ttlMsOverride?: number): Promise<string | null>;

  /**
   * Generate a pre-signed PUT URL for direct agent upload.
   * Uses the external endpoint (container-routable) when configured.
   */
  getUploadUrl(key: string): Promise<string>;

  /**
   * Generate a pre-signed PUT URL using the internal endpoint.
   * Use this when the uploader is on the host (e.g., CLI uploads),
   * not in a container. Falls back to getUploadUrl() when no
   * external endpoint is configured.
   */
  getInternalUploadUrl(key: string): Promise<string>;

  /**
   * Set initial metadata on an object that was uploaded via pre-signed URL.
   * Pre-signed PUT URLs cannot carry custom metadata, so this must be called
   * after the agent confirms upload via cache.upload.complete.
   * Sets created-at and last-accessed-at to now.
   */
  initMeta(key: string): Promise<void>;

  /**
   * List object keys (relative to the configured prefix) under a sub-prefix,
   * newest first (by createdAt/last-modified metadata; falls back to
   * lexicographic when metadata is unavailable). Returns full cache keys
   * (without the storage prefix). Returns an empty array when nothing matches.
   */
  list(subPrefix: string): Promise<string[]>;

  /** Server-side copy from one cache key to another (used for atomic temp -> final commit). */
  copy(srcKey: string, destKey: string): Promise<void>;

  /**
   * Read the stored metadata (createdAt + lastAccessedAt) for a key WITHOUT
   * refreshing lastAccessedAt. Returns null when the key is missing or carries
   * no metadata. A pure read (no TTL-expiry side effect) — used by quota
   * eviction to order candidates by access recency.
   */
  getMetadata(key: string): Promise<CacheMetadata | null>;
}

import type { SharedS3Config } from '@kici-dev/shared';

/**
 * S3 backend config. Extends the generic `SharedS3Config` from
 * `@kici-dev/shared` with the cache-specific `ttlMs` knob.
 */
export type S3CacheStorageConfig = SharedS3Config & {
  type: 's3';
  ttlMs: number;
  /** Host-facing pre-signed upload endpoint (see S3CacheStorageOptions.uploadEndpoint). */
  uploadEndpoint?: string;
};

/**
 * Filesystem backend config. Stores blobs as files under `basePath` and
 * mints HMAC-signed `http://baseUrl<routePrefix>...` URLs that the
 * orchestrator's `/api/v1/cache/blob/*` route verifies before serving.
 *
 * Intended for single-host / E2E sandboxes where standing up an
 * S3-compatible service is overkill.
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

/**
 * Configuration for creating a cache storage backend. Discriminated union
 * keyed on `type` so new backends slot in without breaking consumers.
 */
export type CacheStorageConfig = S3CacheStorageConfig | FilesystemCacheStorageConfig;
