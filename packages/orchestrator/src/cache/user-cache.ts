/**
 * User-facing cache layer wrapping CacheStorage.
 *
 * Namespacing: `cache/<orgId>/<repoId>/<refScope>/<key>-<discriminator>.tar.gz`.
 * The discriminator is a hash of the exact cache key, so keys differing only by
 * case stay two objects on a case-insensitive store. `refScope` is `shared` for
 * trusted refs (org-shared, default-branch cache) or `iso/<runId>` for
 * untrusted refs. An untrusted ref reads the shared scope as a fallback but can
 * NEVER write it — the GitHub Actions cache-isolation model. Keyed strictly per
 * org so no tenant can read another tenant's cache.
 *
 * Saves are immutable (first save under an exact key wins) and atomic (upload
 * to `.tmp-<uuid>`, server-side copy to the final key, delete the temp), so a
 * crashed save never leaves a corrupt final entry.
 *
 * Eviction: per-org byte quota plus the TTL the backing CacheStorage enforces
 * lazily on access. A save that pushes the org over quota evicts LRU entries
 * (oldest `lastAccessedAt` from backend metadata) until under quota, logging
 * each. The `.hash` / `.size` sidecars carry the integrity hash and size
 * accounting outside the presigned, metadata-less tarball upload.
 */
import { randomUUID } from 'node:crypto';
import { createLogger } from '@kici-dev/shared';
import type { CacheRefScope } from '@kici-dev/engine';
import type { CacheStorage } from '../storage/types.js';
import { KEY_DISCRIMINATOR_LENGTH, keyDiscriminator } from '../storage/key-discriminator.js';

const logger = createLogger({ prefix: 'user-cache' });

/**
 * Cluster-wide default quota: 5 GiB, used when an org has no
 * `org_settings.user_cache_quota_bytes` override. Operator-configurable via
 * KICI_USER_CACHE_QUOTA_BYTES.
 */
export const DEFAULT_USER_CACHE_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
/**
 * Cluster-wide default entry TTL: 7 days, used when an org has no
 * `org_settings.user_cache_ttl_ms` override. Operator-configurable via
 * KICI_USER_CACHE_TTL_MS.
 */
export const DEFAULT_USER_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Per-org quota + TTL override, read from `org_settings` at operation time; an
 * `undefined` field means the cluster-wide default applies. Injected so the
 * cache stays decoupled from the DB layer (and unit-testable with a stub).
 */
export interface UserCacheOrgLimits {
  quotaBytes?: number;
  ttlMs?: number;
}

/** Resolves the per-org cache limits for an org id (e.g. an `org_settings` read). */
export type UserCacheOrgLimitsReader = (orgId: string) => Promise<UserCacheOrgLimits>;

/** Tarball suffix for committed cache entries. */
const TAR_SUFFIX = '.tar.gz';

/** Stem of an in-flight upload, `.tmp-<uuid>.tar.gz`, before commit copies it to its final key. */
const TEMP_UPLOAD_STEM = '.tmp-';

function isTempUpload(key: string): boolean {
  return key.slice(key.lastIndexOf('/') + 1).startsWith(TEMP_UPLOAD_STEM);
}

/** Matches a stem ending in the fixed-width discriminator this module appends. */
const KEY_DISCRIMINATOR_TAIL = new RegExp(`^(.*)-([0-9a-f]{${KEY_DISCRIMINATOR_LENGTH}})$`);

/**
 * Whether a listed object is a committed entry, `<stem>-<discriminator>.tar.gz`.
 * The `restoreKeys` prefix scan filters on it, which keeps out an in-flight
 * `.tmp-` upload (a partial tarball until commit) and an object under the
 * retired un-discriminated layout, which nothing writes.
 */
function isCommittedEntry(key: string): boolean {
  return key.endsWith(TAR_SUFFIX) && KEY_DISCRIMINATOR_TAIL.test(key.slice(0, -TAR_SUFFIX.length));
}

/**
 * Recover the reported cache key from a committed entry's (already sanitized,
 * lossy) stem by undoing the appended discriminator. A stem that itself ends in
 * a discriminator-shaped tail loses it — that affects only the reported
 * `matchedKey`, never which object is served.
 */
function stripKeyDiscriminator(stem: string): string {
  return KEY_DISCRIMINATOR_TAIL.exec(stem)?.[1] ?? stem;
}

/**
 * Sanitize a path segment so a key can never escape its org/repo/scope
 * namespace. An all-dots segment (`.`, `..`, …) is also rewritten: HTTP/S3
 * path canonicalization collapses it (`a/./b` → `a/b`, `a/../b` → `b`), which
 * corrupts the namespace and breaks the SigV4 signature on a pre-signed
 * PUT/GET. The internal provider's repo id `.` hits exactly this case.
 */
function sanitizeSegment(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9._-]/g, '_');
  return /^\.+$/.test(cleaned) ? `_${cleaned}` : cleaned;
}

/** Identifies the org + repo + write scope a cache operation targets. */
export interface UserCacheRef {
  org: string;
  repo: string;
  scope: CacheRefScope;
  /** Required when scope === 'isolated' — the per-run isolation namespace. */
  runId?: string;
}

/** Outcome of a restore: whether an entry matched and how to fetch it. */
export interface UserCacheRestoreResult {
  hit: boolean;
  matchedKey?: string;
  downloadUrl?: string;
  tarHash?: string;
}

/** Outcome of begin-save: a presigned PUT to a temp key, or skip when the key already exists. */
export interface UserCacheBeginSaveResult {
  skip: boolean;
  uploadUrl?: string;
  tempKey?: string;
}

/** Org-level prefix: the per-tenant isolation boundary and quota scope. */
function orgPrefix(ref: UserCacheRef): string {
  return `cache/${sanitizeSegment(ref.org)}/`;
}

/** Org + repo prefix shared by every scope of a repo. */
function repoPrefix(ref: UserCacheRef): string {
  return `${orgPrefix(ref)}${sanitizeSegment(ref.repo)}`;
}

/** Namespace prefix for the WRITE scope of a ref (shared OR per-run isolated). */
function writePrefix(ref: UserCacheRef): string {
  const base = repoPrefix(ref);
  if (ref.scope === 'isolated') {
    if (!ref.runId) throw new Error('isolated cache scope requires a runId');
    return `${base}/iso/${sanitizeSegment(ref.runId)}/`;
  }
  return `${base}/shared/`;
}

/** Namespace prefixes the ref may READ, in priority order. Isolated reads its own run scope, then shared. */
function readPrefixes(ref: UserCacheRef): string[] {
  const base = repoPrefix(ref);
  if (ref.scope === 'isolated') {
    if (!ref.runId) throw new Error('isolated cache scope requires a runId');
    return [`${base}/iso/${sanitizeSegment(ref.runId)}/`, `${base}/shared/`];
  }
  return [`${base}/shared/`];
}

/**
 * Object key for a committed cache entry. The trailing discriminator, a hash of
 * the EXACT cache key, keeps `build` and `Build` apart on a case-insensitive
 * namespace (the filesystem backend on macOS or Windows), where a restore could
 * otherwise return the other key's tarball. It is deliberately a SUFFIX:
 * `restoreByPrefix` matches `restoreKeys` by string prefix, so only the
 * `matchedKey` slice has to know about it.
 */
function finalKey(prefix: string, key: string): string {
  return `${prefix}${sanitizeSegment(key)}-${keyDiscriminator(key)}${TAR_SUFFIX}`;
}

/** The writer's object key for `key` under this ref, used by `beginSave` and `commitSave`. */
function userCacheEntryKey(ref: UserCacheRef, key: string): string {
  return finalKey(writePrefix(ref), key);
}

export class UserCache {
  private readonly storage: CacheStorage;
  /** `KICI_USER_CACHE_QUOTA_BYTES`. */
  private readonly defaultQuotaBytes: number;
  /** `KICI_USER_CACHE_TTL_MS`. */
  private readonly defaultTtlMs: number;
  /** Absent = always use the cluster defaults. */
  private readonly orgLimitsReader?: UserCacheOrgLimitsReader;

  constructor(opts: {
    storage: CacheStorage;
    /** Cluster-wide default quota (env-var default). */
    quotaBytes?: number;
    /** Cluster-wide default TTL (env-var default). */
    ttlMs?: number;
    /** Per-org override reader (org_settings). */
    orgLimitsReader?: UserCacheOrgLimitsReader;
  }) {
    this.storage = opts.storage;
    this.defaultQuotaBytes = opts.quotaBytes ?? DEFAULT_USER_CACHE_QUOTA_BYTES;
    this.defaultTtlMs = opts.ttlMs ?? DEFAULT_USER_CACHE_TTL_MS;
    this.orgLimitsReader = opts.orgLimitsReader;
  }

  /**
   * Per-org override when present, else the cluster default. A reader failure
   * falls back to the defaults (logged): a settings-lookup hiccup must never
   * fail a restore/save.
   */
  private async resolveLimits(org: string): Promise<{ quotaBytes: number; ttlMs: number }> {
    if (!this.orgLimitsReader) {
      return { quotaBytes: this.defaultQuotaBytes, ttlMs: this.defaultTtlMs };
    }
    let limits: UserCacheOrgLimits = {};
    try {
      limits = await this.orgLimitsReader(org);
    } catch (err) {
      logger.warn('user-cache org-limits lookup failed — using cluster defaults', {
        org,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return {
      quotaBytes: limits.quotaBytes ?? this.defaultQuotaBytes,
      ttlMs: limits.ttlMs ?? this.defaultTtlMs,
    };
  }

  /** Restore: try the exact key across read prefixes, then restoreKeys prefix scan (newest wins). */
  async restore(
    ref: UserCacheRef & { key: string; restoreKeys?: string[] },
  ): Promise<UserCacheRestoreResult> {
    const { ttlMs } = await this.resolveLimits(ref.org);
    const prefixes = readPrefixes(ref);
    const exact = await this.restoreExact(ref, prefixes, ttlMs);
    if (exact) return exact;
    return (await this.restoreByPrefix(ref, prefixes, ttlMs)) ?? { hit: false };
  }

  /** Try the exact key in read-prefix priority order. */
  private async restoreExact(
    ref: UserCacheRef & { key: string },
    prefixes: string[],
    ttlMs: number,
  ): Promise<UserCacheRestoreResult | null> {
    for (const prefix of prefixes) {
      const key = finalKey(prefix, ref.key);
      const url = await this.storage.getUrl(key, ttlMs);
      if (url) {
        await this.storage.touch(key);
        return {
          hit: true,
          matchedKey: ref.key,
          downloadUrl: url,
          tarHash: await this.readHash(key),
        };
      }
    }
    return null;
  }

  /** restoreKeys prefix fallback (ordered); within a prefix, list() returns newest-first. */
  private async restoreByPrefix(
    ref: UserCacheRef & { restoreKeys?: string[] },
    prefixes: string[],
    ttlMs: number,
  ): Promise<UserCacheRestoreResult | null> {
    for (const rk of ref.restoreKeys ?? []) {
      for (const prefix of prefixes) {
        const matches = (await this.storage.list(`${prefix}${sanitizeSegment(rk)}`)).filter(
          isCommittedEntry,
        );
        if (matches.length === 0) continue;
        const winner = matches[0]; // newest-first
        const url = await this.storage.getUrl(winner, ttlMs);
        if (!url) continue;
        await this.storage.touch(winner);
        const matchedKey = stripKeyDiscriminator(winner.slice(prefix.length, -TAR_SUFFIX.length));
        return { hit: true, matchedKey, downloadUrl: url, tarHash: await this.readHash(winner) };
      }
    }
    return null;
  }

  /** Begin a save: presigned PUT to a temp key, or skip=true when the immutable key exists. */
  async beginSave(ref: UserCacheRef & { key: string }): Promise<UserCacheBeginSaveResult> {
    const final = userCacheEntryKey(ref, ref.key);
    if (await this.storage.has(final)) {
      logger.info('user-cache save skipped (immutable key exists)', { key: ref.key });
      return { skip: true };
    }
    const tempKey = `${writePrefix(ref)}${TEMP_UPLOAD_STEM}${randomUUID()}${TAR_SUFFIX}`;
    const uploadUrl = await this.storage.getUploadUrl(tempKey);
    return { skip: false, uploadUrl, tempKey };
  }

  /** Commit a save: copy temp -> final, init metadata, store companion hash/size, delete temp, enforce quota. */
  async commitSave(
    ref: UserCacheRef & { key: string; tarHash: string; sizeBytes: number; tempKey?: string },
  ): Promise<void> {
    const final = userCacheEntryKey(ref, ref.key);
    if (await this.storage.has(final)) return; // race: someone committed first — immutable no-op
    if (ref.tempKey) {
      await this.storage.copy(ref.tempKey, final);
      await this.storage.delete(ref.tempKey);
    }
    await this.storage.initMeta(final);
    await this.storage.put(`${final}.hash`, ref.tarHash);
    await this.storage.put(`${final}.size`, String(ref.sizeBytes));
    logger.info('user-cache entry committed', { key: ref.key, sizeBytes: ref.sizeBytes });
    await this.enforceQuota(ref);
  }

  private async readHash(key: string): Promise<string | undefined> {
    const data = await this.storage.get(`${key}.hash`);
    return data?.toString('utf-8') || undefined;
  }

  /**
   * Evict the org's LRU entries until total tarball size <= the per-org quota.
   * An in-flight `.tmp-` upload is never a candidate: with no metadata it would
   * rank oldest and be reclaimed first, freeing nothing (no `.size`) and failing
   * the concurrent commit's copy. Retired un-discriminated entries stay
   * candidates: they hold accounted bytes.
   */
  private async enforceQuota(ref: UserCacheRef): Promise<void> {
    const { quotaBytes } = await this.resolveLimits(ref.org);
    const keys = (await this.storage.list(orgPrefix(ref))).filter(
      (k) => k.endsWith(TAR_SUFFIX) && !isTempUpload(k),
    );
    const sized: { key: string; size: number }[] = [];
    let total = 0;
    for (const k of keys) {
      const sizeData = await this.storage.get(`${k}.size`);
      const size = sizeData ? Number(sizeData.toString('utf-8')) : 0;
      total += size;
      sized.push({ key: k, size });
    }
    if (total <= quotaBytes) return;
    // Access metadata is fetched only when over quota, so the common path never
    // pays for it. Missing metadata means an orphan/corrupt entry: rank it oldest.
    const candidates: { key: string; size: number; lastAccessed: number }[] = [];
    for (const e of sized) {
      const meta = await this.storage.getMetadata(e.key);
      const lastAccessed = meta ? new Date(meta.lastAccessedAt).getTime() : 0;
      candidates.push({ key: e.key, size: e.size, lastAccessed });
    }
    candidates.sort((a, b) => a.lastAccessed - b.lastAccessed);
    for (const { key, size } of candidates) {
      if (total <= quotaBytes) break;
      await this.storage.delete(key);
      await this.storage.delete(`${key}.hash`);
      await this.storage.delete(`${key}.size`);
      total -= size;
      logger.info('user-cache eviction (org over quota)', { org: ref.org, key, freedBytes: size });
    }
  }
}
