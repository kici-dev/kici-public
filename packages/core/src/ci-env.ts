/** Values that mean "explicitly off", compared case-insensitively. */
const FALSY_FLAG_VALUES = new Set(['0', 'false']);

/**
 * Whether one CI marker's value counts as set: non-empty after trimming (so
 * `CI=''` and `CI='   '` are unset, unlike an `'CI' in env` check) and not an
 * opt-out. Like `is-in-ci`, `0` and `false` are opt-outs, here
 * case-insensitively.
 *
 * CI markers only: `KICI_*` flags use strict `=== 'true'`, and reading one with
 * this predicate would make `KICI_DEBUG=off` turn debugging on.
 */
export function isCiMarkerSet(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === '') return false;
  return !FALSY_FLAG_VALUES.has(normalized);
}

/**
 * Whether the process runs in CI — the codebase's single definition, so flow
 * selection, prompt suppression and service installation never disagree.
 *
 * `CI=false` cancels only the generic marker: a set GITHUB_ACTIONS / GITLAB_CI
 * names a real browserless runner, so it still wins. This deliberately differs
 * from `ci-info` (where `CI=false` is a global bypass) and is pinned by test.
 * Each vendor marker has its own opt-out (`GITHUB_ACTIONS=false`). `env` is
 * injectable so callers and tests pass a fixture instead of mutating
 * `process.env`.
 */
export function isCiEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return isCiMarkerSet(env.CI) || isCiMarkerSet(env.GITHUB_ACTIONS) || isCiMarkerSet(env.GITLAB_CI);
}
