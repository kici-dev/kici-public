/** Values that mean "explicitly off", compared case-insensitively. */
const FALSY_FLAG_VALUES = new Set(['0', 'false']);

/**
 * Whether one CI marker's value counts as set, under the CI opt-out convention:
 * the marker counts only when it is non-empty and is not an explicit opt-out.
 *
 * Follows `is-in-ci` in treating both `0` and `false` as opt-outs, and adds
 * case-insensitivity so `False` behaves like `false`. Deliberately checks for
 * an empty value rather than `'CI' in env`, so an unset-looking value is "not
 * set" — and the emptiness check runs on the trimmed value, so a whitespace-only
 * `CI='   '` is "not set" for the same reason `CI=''` is.
 *
 * Scoped to CI markers on purpose. `KICI_*` flags use strict `=== 'true'`; do
 * not reach for this predicate to read one, or `KICI_DEBUG=off` silently turns
 * debugging on.
 */
export function isCiMarkerSet(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === '') return false;
  return !FALSY_FLAG_VALUES.has(normalized);
}

/**
 * Whether the process is running in a CI environment.
 *
 * The single definition of that question for the whole codebase: flow selection,
 * prompt suppression, and service installation all read it, so they cannot
 * disagree about the same shell.
 *
 * `CI=false` cancels the generic marker only — a GITHUB_ACTIONS / GITLAB_CI
 * marker set to a non-opt-out value names a real browserless runner rather than
 * a user's intent, so it still wins. This diverges from `ci-info`, where
 * `CI=false` is a global bypass; the divergence is deliberate and pinned by
 * test. Each vendor marker carries its own opt-out, so `GITHUB_ACTIONS=false`
 * cancels that marker without touching `CI`.
 *
 * `env` is injectable so callers and tests can supply a fixture instead of
 * mutating `process.env`.
 */
export function isCiEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return isCiMarkerSet(env.CI) || isCiMarkerSet(env.GITHUB_ACTIONS) || isCiMarkerSet(env.GITLAB_CI);
}
