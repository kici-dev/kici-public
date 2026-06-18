/**
 * Filesystem-backed cache storage.
 *
 * Mirrors the `CacheStorage` interface that `S3CacheStorage` provides, but
 * stores blobs as files under a configured base directory. Pre-signed URLs
 * are replaced by HMAC-signed `http://<orchUrl>/api/v1/cache/blob/...` URLs
 * — see `sign-url.ts` for the token mechanics and `app.ts` for the route.
 *
 * Intended for single-host deployments and E2E sandboxes where standing up
 * an S3-compatible service is overkill. Production should still use S3.
 *
 * Metadata is co-located as a sibling JSON file (`<key>.meta.json`) so the
 * data file is byte-identical to what the agent receives over HTTP. TTL is
 * enforced lazily on access — same model as the S3 backend.
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { CacheMetadata, CacheStorage } from './types.js';
import { signToken } from './sign-url.js';

export interface FilesystemCacheStorageOptions {
  /** Absolute path to the cache root directory. Created on first write if missing. */
  basePath: string;
  /** Item TTL in milliseconds. Items past TTL since lastAccessedAt are evicted. */
  ttlMs: number;
  /** Base URL the agent uses to reach the orchestrator (e.g., `http://orch:10143`). */
  baseUrl: string;
  /** Per-process HMAC secret used to sign URLs. See sign-url.ts. */
  signingSecret: string;
  /** Optional URL path mount point. Defaults to `/api/v1/cache/blob/`. */
  routePrefix?: string;
}

const DEFAULT_ROUTE_PREFIX = '/api/v1/cache/blob/';

export class FilesystemCacheStorage implements CacheStorage {
  private readonly basePath: string;
  private readonly ttlMs: number;
  private readonly baseUrl: string;
  private readonly signingSecret: string;
  private readonly routePrefix: string;

  constructor(options: FilesystemCacheStorageOptions) {
    this.basePath = options.basePath;
    this.ttlMs = options.ttlMs;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.signingSecret = options.signingSecret;
    this.routePrefix = (options.routePrefix ?? DEFAULT_ROUTE_PREFIX).replace(/\/?$/, '/');
  }

  // -- Path layout --

  /**
   * Map a cache key to its on-disk path. Keys may contain `/`, which becomes a
   * directory separator. Reject keys containing `..` segments or NUL bytes to
   * prevent path traversal — the same defence the route layer enforces too.
   */
  private resolvePath(key: string): string {
    if (key.includes('\0') || key.split('/').some((seg) => seg === '..' || seg === ''))
      throw new Error(`Invalid cache key: ${JSON.stringify(key)}`);
    return join(this.basePath, key);
  }

  /** Public for the HTTP route. The route validates the key before calling. */
  pathFor(key: string): string {
    return this.resolvePath(key);
  }

  private metaPath(key: string): string {
    return `${this.resolvePath(key)}.meta.json`;
  }

  // -- Metadata --

  private isExpired(meta: CacheMetadata, ttlMsOverride?: number): boolean {
    const ttl = ttlMsOverride ?? this.ttlMs;
    const lastAccessed = new Date(meta.lastAccessedAt).getTime();
    return Date.now() - lastAccessed > ttl;
  }

  private async readMeta(key: string): Promise<CacheMetadata | null> {
    try {
      const raw = await fs.readFile(this.metaPath(key), 'utf-8');
      const parsed = JSON.parse(raw) as CacheMetadata;
      if (typeof parsed.createdAt !== 'string' || typeof parsed.lastAccessedAt !== 'string')
        return null;
      return parsed;
    } catch (err: unknown) {
      if (isNotFoundFsError(err)) return null;
      throw err;
    }
  }

  private async writeMeta(key: string, meta: CacheMetadata): Promise<void> {
    const path = this.metaPath(key);
    await fs.mkdir(dirname(path), { recursive: true });
    await writeFileAtomic(path, JSON.stringify(meta));
  }

  // -- CacheStorage interface --

  async put(key: string, data: Buffer | string): Promise<void> {
    const path = this.resolvePath(key);
    await fs.mkdir(dirname(path), { recursive: true });
    const body = typeof data === 'string' ? Buffer.from(data) : data;
    await writeFileAtomic(path, body);
    const now = new Date().toISOString();
    await this.writeMeta(key, { createdAt: now, lastAccessedAt: now });
  }

  async get(key: string, ttlMsOverride?: number): Promise<Buffer | null> {
    const meta = await this.readMeta(key);
    if (!meta) return null;
    if (this.isExpired(meta, ttlMsOverride)) {
      await this.deleteFiles(key);
      return null;
    }
    let data: Buffer;
    try {
      data = await fs.readFile(this.resolvePath(key));
    } catch (err: unknown) {
      if (isNotFoundFsError(err)) return null;
      throw err;
    }
    try {
      meta.lastAccessedAt = new Date().toISOString();
      await this.writeMeta(key, meta);
    } catch {
      // Best-effort: a metadata-write failure must not lose the read data.
    }
    return data;
  }

  async has(key: string, ttlMsOverride?: number): Promise<boolean> {
    const meta = await this.readMeta(key);
    if (!meta) return false;
    if (this.isExpired(meta, ttlMsOverride)) {
      await this.deleteFiles(key);
      return false;
    }
    return true;
  }

  async delete(key: string): Promise<boolean> {
    const meta = await this.readMeta(key);
    const existed = meta !== null;
    await this.deleteFiles(key);
    return existed;
  }

  async touch(key: string): Promise<void> {
    const meta = await this.readMeta(key);
    if (!meta) return;
    meta.lastAccessedAt = new Date().toISOString();
    await this.writeMeta(key, meta);
  }

  async getUrl(key: string, ttlMsOverride?: number): Promise<string | null> {
    const meta = await this.readMeta(key);
    if (!meta) return null;
    if (this.isExpired(meta, ttlMsOverride)) {
      await this.deleteFiles(key);
      return null;
    }
    return this.signedUrl('GET', key);
  }

  async getUploadUrl(key: string): Promise<string> {
    return this.signedUrl('PUT', key);
  }

  async getInternalUploadUrl(key: string): Promise<string> {
    return this.signedUrl('PUT', key);
  }

  async initMeta(key: string): Promise<void> {
    const now = new Date().toISOString();
    await this.writeMeta(key, { createdAt: now, lastAccessedAt: now });
  }

  async list(subPrefix: string): Promise<string[]> {
    const root = this.resolvePath(subPrefix.replace(/\/$/, ''));
    let entries: { key: string; mtime: number }[];
    try {
      entries = await this.walkDataFiles(root, subPrefix.replace(/\/$/, ''));
    } catch (err: unknown) {
      if (isNotFoundFsError(err)) return [];
      throw err;
    }
    entries.sort((a, b) => b.mtime - a.mtime); // newest first
    return entries.map((e) => e.key);
  }

  async getMetadata(key: string): Promise<CacheMetadata | null> {
    return this.readMeta(key);
  }

  async copy(srcKey: string, destKey: string): Promise<void> {
    const srcPath = this.resolvePath(srcKey);
    const destPath = this.resolvePath(destKey);
    await fs.mkdir(dirname(destPath), { recursive: true });
    await fs.copyFile(srcPath, destPath);
    const now = new Date().toISOString();
    await this.writeMeta(destKey, { createdAt: now, lastAccessedAt: now });
  }

  // -- Internal --

  /**
   * Recursively collect data files under `dir`, returning each as a cache key
   * relative to `basePath` paired with its mtime. Metadata sidecars
   * (`*.meta.json`) and the atomic-write temp files (`*.tmp-*`) are skipped so
   * `list()` only surfaces real cache objects.
   */
  private async walkDataFiles(
    dir: string,
    keyPrefix: string,
  ): Promise<{ key: string; mtime: number }[]> {
    const out: { key: string; mtime: number }[] = [];
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      const childPath = join(dir, dirent.name);
      const childKey = keyPrefix ? `${keyPrefix}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        out.push(...(await this.walkDataFiles(childPath, childKey)));
        continue;
      }
      if (dirent.name.endsWith('.meta.json') || /\.tmp-[0-9a-f]+$/.test(dirent.name)) continue;
      const stat = await fs.stat(childPath);
      out.push({ key: childKey, mtime: stat.mtimeMs });
    }
    return out;
  }

  private signedUrl(method: 'GET' | 'PUT', key: string): string {
    const { token } = signToken(this.signingSecret, method, key);
    const encodedKey = key
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    return `${this.baseUrl}${this.routePrefix}${encodedKey}?sig=${encodeURIComponent(token)}`;
  }

  private async deleteFiles(key: string): Promise<void> {
    await fs.rm(this.resolvePath(key), { force: true });
    await fs.rm(this.metaPath(key), { force: true });
  }
}

function isNotFoundFsError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

/**
 * Write a file atomically: write to a temp sibling, fsync, rename. Avoids
 * partial reads if the orchestrator crashes mid-write. The temp suffix is
 * randomised so concurrent writers don't collide on the same temp name.
 */
async function writeFileAtomic(path: string, data: Buffer | string): Promise<void> {
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, path);
}
