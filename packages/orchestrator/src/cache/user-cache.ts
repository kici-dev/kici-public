/**
 * User-facing cache layer wrapping CacheStorage.
 *
 * Namespacing: `cache/<orgId>/<repoId>/<refScope>/<key>-<discriminator>.tar.gz`.
 * The discriminator is a hash of the exact cache key, so two keys differing
 * only by case stay two objects even on a case-insensitive store. `refScope`
 * is `shared` for trusted refs (org-shared, default-branch cache)
 * or `iso/<runId>` for untrusted refs (per-run isolated scope). Restores from
 * an untrusted ref read the shared scope as a fallback but writes can NEVER
 * land in the shared scope — the GitHub Actions cache-isolation model. Keyed
 * strictly per org so no tenant can read another tenant's cache.
 *
 * Saves are immutable (first save under an exact key wins) and atomic
 * (upload to a `.tmp-<uuid>` key, then server-side copy to the final key and
 * delete the temp), so a crashed save never leaves a corrupt final entry.
 *
 * Eviction: per-org byte quota plus the TTL the backing CacheStorage already
 * enforces lazily on access. On a save that pushes the org over quota,
 * least-recently-used entries (oldest `lastAccessedAt`, read from the storage
 * backend's metadata) are evicted until under quota; each eviction is logged.
 * The companion `.hash` / `.size` sidecar objects carry the integrity
 * hash and size accounting outside the tarball's own (presigned, metadata-less)
 * upload.
 */
import { randomUUID } from 'node:crypto';
import { createLogger } from '@kici-dev/shared';
import type { CacheRefScope } from '@kici-dev/engine';
import type { CacheStorage } from '../storage/types.js';
import { KEY_DISCRIMINATOR_LENGTH, keyDiscriminator } from '../storage/key-discriminator.js';

const logger = createLogger({ prefix: 'user-cache' });

/**
 * Cluster-wide default quota: 5 GiB. Serves as the fallback when an org has no
 * per-org override in `org_settings.user_cache_quota_bytes`. The cluster-wide
 * value is itself operator-configurable via KICI_USER_CACHE_QUOTA_BYTES.
 */
export const DEFAULT_USER_CACHE_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
/**
 * Cluster-wide default entry TTL: 7 days. Fallback when an org has no per-org
 * override in `org_settings.user_cache_ttl_ms`. The cluster-wide value is
 * operator-configurable via KICI_USER_CACHE_TTL_MS.
 */
export const DEFAULT_USER_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Per-org override of the cache quota + TTL, read from `org_settings` at
 * operation time. A field left `undefined` means "no per-org override" — the
 * cluster-wide default applies. Injected into `UserCache` so the cache stays
 * decoupled from the DB layer (and unit-testable with a stub reader).
 */
export interface UserCacheOrgLimits {
  quotaBytes?: number;
  ttlMs?: number;
}

/** Resolves the per-org cache limits for an org id (e.g. an `org_settings` read). */
export type UserCacheOrgLimitsReader = (orgId: string) => Promise<UserCacheOrgLimits>;

/** Tarball suffix for committed cache entries. */
const TAR_SUFFIX = '.tar.gz';

/** Matches a stem ending in the fixed-width discriminator this module appends. */
const KEY_DISCRIMINATOR_TAIL = new RegExp(`^(.*)-([0-9a-f]{${KEY_DISCRIMINATOR_LENGTH}})$`);

/**
 * Recover the reported cache key from a stored object's stem.
 *
 * The value on this path is already the sanitized, lossy form, so this only
 * needs to undo the discriminator the key format appends. A stem that itself
 * ends in a discriminator-shaped tail loses it — that affects only the string
 * reported back as `matchedKey`, never which object is served.
 */
function stripKeyDiscriminator(stem: string): string {
  return KEY_DISCRIMINATOR_TAIL.exec(stem)?.[1] ?? stem;
}

/** Device names NTFS reserves; a file cannot actually be created under one. */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/;

/** Keys that cannot have been part of a case collision in the old key format. */
const UNAMBIGUOUS_LEGACY_KEY = /^[a-z0-9_][a-z0-9._-]*$/;

/**
 * Whether a cache key is safe to look up in the pre-discriminator key format.
 *
 * Every clause rules out a way the old format could have folded two distinct
 * keys onto one object:
 *
 * - the character class is a subset of what `seg()` preserves, so a match
 *   implies the key survives sanitization unchanged (no many-to-one rewrite)
 *   and is pure ASCII, which rules out HFS+ Unicode normalisation;
 * - requiring lowercase rules out case folding, the collision this change fixes;
 * - a trailing `.` is stripped by NTFS, and a reserved device name cannot be
 *   created there at all.
 *
 * A key failing any clause simply gets no legacy fallback — it is re-fetched
 * and re-saved under the discriminated key, which is always correct.
 */
function unambiguousLegacyKey(key: string): boolean {
  return UNAMBIGUOUS_LEGACY_KEY.test(key) && !key.endsWith('.') && !WINDOWS_RESERVED_NAME.test(key);
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

export class UserCache {
  private readonly storage: CacheStorage;
  /** Cluster-wide default quota (the `KICI_USER_CACHE_QUOTA_BYTES` value). */
  private readonly defaultQuotaBytes: number;
  /** Cluster-wide default TTL (the `KICI_USER_CACHE_TTL_MS` value). */
  private readonly defaultTtlMs: number;
  /** Optional per-org override reader; absent = always use the cluster defaults. */
  private readonly orgLimitsReader?: UserCacheOrgLimitsReader;

  constructor(opts: {
    storage: CacheStorage;
    /** Cluster-wide default quota (env-var default). */
    quotaBytes?: number;
    /** Cluster-wide default TTL (env-var default). */
    ttlMs?: number;
    /** Per-org override reader (org_settings). When unset, defaults apply. */
    orgLimitsReader?: UserCacheOrgLimitsReader;
  }) {
    this.storage = opts.storage;
    this.defaultQuotaBytes = opts.quotaBytes ?? DEFAULT_USER_CACHE_QUOTA_BYTES;
    this.defaultTtlMs = opts.ttlMs ?? DEFAULT_USER_CACHE_TTL_MS;
    this.orgLimitsReader = opts.orgLimitsReader;
  }

  /**
   * Resolve the effective quota + TTL for an org: the per-org override from
   * `org_settings` when present, otherwise the cluster-wide default. A reader
   * failure falls back to the defaults (logged) — the cache must never fail a
   * restore/save because the settings lookup hiccupped.
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

  /**
   * Sanitize a path segment so a key can never escape its org/repo/scope
   * namespace. Beyond stripping disallowed characters, a segment consisting
   * only of dots (`.`, `..`, …) is replaced wholesale: such a segment is a
   * dot-segment that HTTP/S3 path canonicalization collapses (`a/./b` → `a/b`,
   * `a/../b` → `b`), which both corrupts the namespace and breaks the SigV4
   * signature on a pre-signed PUT/GET. Repo identifiers like `.` (the internal
   * provider's repo id) hit exactly this case, so the all-dots guard keeps the
   * object key canonical and the namespace boundary intact.
   */
  private seg(s: string): string {
    const cleaned = s.replace(/[^A-Za-z0-9._-]/g, '_');
    return /^\.+$/.test(cleaned) ? `_${cleaned}` : cleaned;
  }

  /** Org-level prefix: the per-tenant isolation boundary and quota scope. */
  private orgPrefix(ref: UserCacheRef): string {
    return `cache/${this.seg(ref.org)}/`;
  }

  /** Org + repo prefix shared by every scope of a repo. */
  private repoPrefix(ref: UserCacheRef): string {
    return `${this.orgPrefix(ref)}${this.seg(ref.repo)}`;
  }

  /** Namespace prefix for the WRITE scope of a ref (shared OR per-run isolated). */
  private writePrefix(ref: UserCacheRef): string {
    const base = this.repoPrefix(ref);
    if (ref.scope === 'isolated') {
      if (!ref.runId) throw new Error('isolated cache scope requires a runId');
      return `${base}/iso/${this.seg(ref.runId)}/`;
    }
    return `${base}/shared/`;
  }

  /** Namespace prefixes the ref may READ, in priority order. Isolated reads its own run scope, then shared. */
  private readPrefixes(ref: UserCacheRef): string[] {
    const base = this.repoPrefix(ref);
    if (ref.scope === 'isolated') {
      if (!ref.runId) throw new Error('isolated cache scope requires a runId');
      return [`${base}/iso/${this.seg(ref.runId)}/`, `${base}/shared/`];
    }
    return [`${base}/shared/`];
  }

  /**
   * Object key for a committed cache entry.
   *
   * The trailing discriminator is a hash of the EXACT cache key, and it is what
   * keeps `build` and `Build` apart on a case-insensitive namespace — the
   * filesystem backend on a macOS or Windows host, where the two would
   * otherwise resolve to one object and a restore could return the other key's
   * tarball.
   *
   * It is deliberately a SUFFIX: `restoreByPrefix` matches `restoreKeys` by
   * string prefix, so appending leaves those semantics untouched. The only
   * parse that has to know about it is the `matchedKey` slice.
   */
  private finalKey(prefix: string, key: string): string {
    return `${prefix}${this.seg(key)}-${keyDiscriminator(key)}${TAR_SUFFIX}`;
  }

  /**
   * The pre-discriminator object key.
   *
   * @deprecated Read-only compatibility path for entries written before the key
   * carried a discriminator. Nothing writes this format; it is removed at the
   * next major, by which point every such entry has aged out of the cache TTL.
   */
  private legacyFinalKey(prefix: string, key: string): string {
    return `${prefix}${this.seg(key)}${TAR_SUFFIX}`;
  }

  /**
   * Restore an entry still stored in the pre-discriminator key format.
   *
   * Two gates, and BOTH are load-bearing — dropping either re-creates the
   * wrong-cache-hit this change fixes:
   *
   * 1. `unambiguousLegacyKey` statically rules out any key that could have
   *    collided with a case variant in the old format.
   * 2. The listed name must match byte-exactly. A case-insensitive backend
   *    resolves `getUrl('build')` to an object created as `Build`, but its
   *    *listing* reports the real created name — so comparing against the
   *    listing is what detects that the object is not really ours.
   *
   * @deprecated Removed at the next major; see `legacyFinalKey`.
   */
  private async restoreLegacyExact(
    ref: UserCacheRef & { key: string },
    prefix: string,
    ttlMs: number,
  ): Promise<UserCacheRestoreResult | null> {
    if (!unambiguousLegacyKey(ref.key)) return null;
    const legacyKey = this.legacyFinalKey(prefix, ref.key);
    if (!(await this.storage.list(prefix)).includes(legacyKey)) return null;
    const url = await this.storage.getUrl(legacyKey, ttlMs);
    if (!url) return null;
    await this.storage.touch(legacyKey);
    return {
      hit: true,
      matchedKey: ref.key,
      downloadUrl: url,
      tarHash: await this.readHash(legacyKey),
    };
  }

  /** Restore: try the exact key across read prefixes, then restoreKeys prefix scan (newest wins). */
  async restore(
    ref: UserCacheRef & { key: string; restoreKeys?: string[] },
  ): Promise<UserCacheRestoreResult> {
    const { ttlMs } = await this.resolveLimits(ref.org);
    const prefixes = this.readPrefixes(ref);
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
      const key = this.finalKey(prefix, ref.key);
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
      // Fall back to the pre-discriminator format within this same prefix, so
      // scope priority (isolated before shared) still dominates key format.
      const legacy = await this.restoreLegacyExact(ref, prefix, ttlMs);
      if (legacy) return legacy;
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
        const matches = (await this.storage.list(`${prefix}${this.seg(rk)}`)).filter((k) =>
          k.endsWith(TAR_SUFFIX),
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
    const prefix = this.writePrefix(ref);
    const final = this.finalKey(prefix, ref.key);
    if (await this.storage.has(final)) {
      logger.info('user-cache save skipped (immutable key exists)', { key: ref.key });
      return { skip: true };
    }
    const tempKey = `${prefix}.tmp-${randomUUID()}${TAR_SUFFIX}`;
    const uploadUrl = await this.storage.getUploadUrl(tempKey);
    return { skip: false, uploadUrl, tempKey };
  }

  /** Commit a save: copy temp -> final, init metadata, store companion hash/size, delete temp, enforce quota. */
  async commitSave(
    ref: UserCacheRef & { key: string; tarHash: string; sizeBytes: number; tempKey?: string },
  ): Promise<void> {
    const prefix = this.writePrefix(ref);
    const final = this.finalKey(prefix, ref.key);
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

  /** Evict least-recently-used entries for the org until total tarball size <= the per-org quota. */
  private async enforceQuota(ref: UserCacheRef): Promise<void> {
    const { quotaBytes } = await this.resolveLimits(ref.org);
    const orgPrefix = this.orgPrefix(ref);
    const keys = (await this.storage.list(orgPrefix)).filter((k) => k.endsWith(TAR_SUFFIX));
    const sized: { key: string; size: number }[] = [];
    let total = 0;
    for (const k of keys) {
      const sizeData = await this.storage.get(`${k}.size`);
      const size = sizeData ? Number(sizeData.toString('utf-8')) : 0;
      total += size;
      sized.push({ key: k, size });
    }
    if (total <= quotaBytes) return;
    // Over quota: order candidates by last-access recency (ascending = least
    // recently used first). Fetch the access metadata only now — the common
    // under-quota path above never pays for it. A missing metadata read means
    // an orphan/corrupt entry: rank it oldest so it is reclaimed first.
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
