/**
 * Canonical secret-scope-name validation, shared by the orchestrator write
 * paths and the dashboard scope form. The rule runs on the PATH portion of a
 * scope (after any `backend:` prefix has been stripped): non-empty, length
 * bounded, `/`-separated non-empty segments, each segment restricted to
 * `[A-Za-z0-9_.-]`, and no `.`/`..` segments. Kept dependency-free so the
 * engine barrel stays browser-safe.
 *
 * Callers pass a bare path, so that precondition holds trivially: a writer
 * never supplies a backend qualifier. The `<backend>:` prefix is added by the
 * resolver when it merges secrets across backends at read time, and stripped
 * again before any per-backend call.
 */

/** Allowed characters in a single `/`-separated scope segment. */
export const SCOPE_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;

/** Maximum total length of a scope path. */
export const SCOPE_NAME_MAX_LENGTH = 512;

/**
 * Validate the path portion of a scope name. Returns a human-readable error
 * message, or `null` when the name is valid.
 */
export function validateScopeName(path: string): string | null {
  if (path.length === 0) {
    return 'Scope name must not be empty';
  }
  if (path.length > SCOPE_NAME_MAX_LENGTH) {
    return `Scope name must be at most ${SCOPE_NAME_MAX_LENGTH} characters`;
  }
  for (const segment of path.split('/')) {
    if (segment.length === 0) {
      return 'Scope name must not contain empty path segments';
    }
    if (segment === '.' || segment === '..') {
      return "Scope name segments must not be '.' or '..'";
    }
    if (!SCOPE_SEGMENT_PATTERN.test(segment)) {
      return 'Scope name may only contain letters, digits, and _ . - characters, separated by /';
    }
  }
  return null;
}

/** Error thrown by {@link assertValidScopeName} for an invalid scope name. */
export class ScopeNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeNameError';
  }
}

/** Throw {@link ScopeNameError} when `path` is not a valid scope name. */
export function assertValidScopeName(path: string): void {
  const error = validateScopeName(path);
  if (error !== null) {
    throw new ScopeNameError(error);
  }
}
