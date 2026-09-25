/**
 * The lock-file fields that key a workflow's dependency-cache entry: the
 * package-manager lockfile hash and the in-repo `workspace:` sibling digest.
 * `null` for each field the lock file does not record.
 *
 * A registration stores this key next to the lock entry it came from, so a run
 * dispatched from the registration probes the dependency cache with the key of
 * that entry's own lock file.
 */
export interface DepCacheKey {
  lockfileHash: string | null;
  siblingsDigest: string | null;
}

/**
 * The dependency-cache key a lock file records. A missing, empty or non-string
 * field reads as `null`, so an operator-supplied lock file cannot store a
 * malformed key.
 */
export function depCacheKeyOf(lockFile: {
  lockfileHash?: unknown;
  siblingsDigest?: unknown;
}): DepCacheKey {
  return {
    lockfileHash: keyField(lockFile.lockfileHash),
    siblingsDigest: keyField(lockFile.siblingsDigest),
  };
}

function keyField(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
