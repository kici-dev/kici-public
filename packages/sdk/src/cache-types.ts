import { z } from 'zod';

/**
 * Declarative + imperative cache specification.
 *
 * `key` is the immutable cache key — the first save under an exact key wins;
 * re-saving the same exact key is a no-op. `paths` are the files/dirs to
 * archive (repo-root-relative or `~`-prefixed). `restoreKeys` are ordered
 * prefix fallbacks tried (newest matching entry wins) when the exact key
 * misses on restore.
 */
export interface CacheSpec {
  /** Exact cache key. First save wins; re-saving an existing key is a no-op. */
  key: string;
  /** Files/directories to cache. Repo-root-relative or `~`-prefixed. */
  paths: string[];
  /** Ordered prefix fallbacks for partial restore; newest matching entry wins. */
  restoreKeys?: string[];
}

/** Zod schema validating a CacheSpec at compile/serialize time. */
export const CacheSpecSchema = z.object({
  key: z.string().min(1, 'cache key must be non-empty'),
  paths: z.array(z.string().min(1)).min(1, 'cache paths must be non-empty'),
  restoreKeys: z.array(z.string().min(1)).optional(),
});

/** Declarative cache field shape: one spec or many. */
export type CacheInput = CacheSpec | CacheSpec[];

/** Coerce the declarative `cache` field into an array (empty when unset). */
export function normalizeCacheSpecs(input: CacheInput | undefined): CacheSpec[] {
  if (input === undefined) return [];
  return Array.isArray(input) ? input : [input];
}

/** Result of an imperative cache restore. */
export interface CacheRestoreResult {
  /** Whether any entry (exact key or a restoreKeys prefix match) was restored. */
  hit: boolean;
  /** The key that actually matched (exact key or the matched prefix entry's full key). */
  matchedKey?: string;
}

/**
 * Imperative cache API exposed on `StepContext` as `ctx.cache`.
 *
 * `restore` tries the exact `key`, then each `restoreKeys` prefix in order
 * (newest matching entry wins). `save` is immutable — the first save under an
 * exact key wins and re-saving an existing key is a no-op.
 */
export interface CacheApi {
  restore(spec: CacheSpec): Promise<CacheRestoreResult>;
  save(spec: CacheSpec): Promise<void>;
}
