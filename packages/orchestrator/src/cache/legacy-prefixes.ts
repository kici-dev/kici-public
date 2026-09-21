/**
 * Classifiers for object keys written under the retired cache layouts.
 *
 * Nothing reads those objects any more: the user cache resolves only
 * discriminated keys, the source cache only `source/v2/…`, and the dependency
 * cache only content-addressed tarballs a pointer names. The cache TTL is
 * enforced lazily, on access, so nothing in the product removes an object
 * nothing reads — a retired `cache/` entry goes only through over-quota
 * eviction, and a retired `source/` or `deps/` object stays until an operator
 * removes it. `kici-admin cache purge-legacy` is that removal path; this module
 * decides what it may delete.
 *
 * The retired shapes, and the current ones they are told apart from:
 *
 * - user cache — `cache/<org>/<repo>/<scope>/<key>.tar.gz` plus its `.hash` and
 *   `.size` sidecars, where the stem carries no discriminator. Current entries
 *   end in `-<discriminator>` (`user-cache.ts`), and an in-flight upload is
 *   `.tmp-<uuid>.tar.gz`; neither is legacy.
 * - source cache — `source/<contentHash>.tar.gz`, a single segment under the
 *   prefix. Current keys sit under `source/v2/<org>/` (`source-cache.ts`).
 * - dependency cache — `deps/<platform>-<arch>/<lockfileHash>.tar.gz` with a
 *   same-stem `.hash` sidecar. Its current shape is `deps/<platform>-<arch>/
 *   <depsHash>.tar.gz` (`dep-cache.ts`): the SAME key shape, so no key on its
 *   own is legacy here. What tells the two apart is the pair — a current
 *   tarball is named by its own content hash and a current pointer by the
 *   lockfile hash, so a tarball whose stem also carries a `.hash` object is a
 *   lockfile-named, retired one. The sidecar itself is left alone: its key is a
 *   valid current pointer key, the reader already treats it as a dangling
 *   pointer, and the next build for that lockfile overwrites it.
 */
import { KEY_DISCRIMINATOR_LENGTH } from '../storage/key-discriminator.js';
import { TEMP_UPLOAD_STEM } from './user-cache.js';

/** The cache prefixes a retired layout can live under. */
export const LEGACY_PREFIXES = ['cache/', 'source/', 'deps/'] as const;
export type LegacyPrefix = (typeof LEGACY_PREFIXES)[number];

/** A sanitized key segment, the character set `sanitizeSegment` preserves. */
const SEGMENT = '[A-Za-z0-9._-]+';
const HEX64 = '[0-9a-f]{64}';

const USER_CACHE_OBJECT = new RegExp(
  `^cache/${SEGMENT}/${SEGMENT}/(?:shared|iso/${SEGMENT})/(${SEGMENT})\\.tar\\.gz(?:\\.hash|\\.size)?$`,
);
const DISCRIMINATED_STEM = new RegExp(`-[0-9a-f]{${KEY_DISCRIMINATOR_LENGTH}}$`);

const LEGACY_SOURCE_TARBALL = new RegExp(`^source/${HEX64}\\.tar\\.gz$`);

const DEP_OBJECT = new RegExp(`^(deps/${SEGMENT}/${HEX64})\\.(tar\\.gz|hash)$`);

/**
 * True only for a key in a retired layout that its shape alone identifies;
 * false for every key the current writers produce.
 *
 * A `deps/` key is never legacy by shape (see the module comment) — use
 * `legacyDepTarballKeys` over a listing for that prefix.
 */
export function isLegacyKey(key: string): boolean {
  const user = USER_CACHE_OBJECT.exec(key);
  if (user) {
    const stem = user[1];
    return !stem.startsWith(TEMP_UPLOAD_STEM) && !DISCRIMINATED_STEM.test(stem);
  }
  return LEGACY_SOURCE_TARBALL.test(key);
}

/**
 * The `deps/` tarballs in a listing that belong to the retired layout: each is
 * paired with a `.hash` object under the same platform segment and stem.
 */
export function legacyDepTarballKeys(keys: readonly string[]): string[] {
  const sidecarStems = new Set<string>();
  for (const key of keys) {
    const m = DEP_OBJECT.exec(key);
    if (m && m[2] === 'hash') sidecarStems.add(m[1]);
  }
  return keys.filter((key) => {
    const m = DEP_OBJECT.exec(key);
    return m !== null && m[2] === 'tar.gz' && sidecarStems.has(m[1]);
  });
}

/** Every legacy key in a listing, grouped by the prefix it lives under. */
export function classifyLegacyKeys(keys: readonly string[]): Map<LegacyPrefix, string[]> {
  const byPrefix = new Map<LegacyPrefix, string[]>();
  const add = (prefix: LegacyPrefix, key: string) => {
    const bucket = byPrefix.get(prefix);
    if (bucket) bucket.push(key);
    else byPrefix.set(prefix, [key]);
  };
  for (const key of keys) {
    if (!isLegacyKey(key)) continue;
    const prefix = LEGACY_PREFIXES.find((p) => key.startsWith(p));
    if (prefix) add(prefix, key);
  }
  for (const key of legacyDepTarballKeys(keys)) add('deps/', key);
  return byPrefix;
}
