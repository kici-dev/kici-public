/**
 * The one definition of which regex flags may survive into a compiled matcher.
 *
 * `g` and `y` make a `RegExp` stateful: the instance carries `lastIndex` across
 * `.test()` calls, so a memoized one returns alternating verdicts for the same
 * input, and a loop over a set of candidates resumes mid-string on the second
 * element. Every matcher this repo compiles is either memoized
 * (`trigger/compiled-matchers.ts`, `labels-match.ts`) or applied to a set
 * (`matcherSatisfiedBy`), and none of them wants sticky or global semantics —
 * they all ask a single yes/no question about one whole string.
 *
 * So the two stateful flags are dropped at every boundary: the SDK producers
 * that read an author's `RegExp`, the compiler that serializes one into the
 * lock file, and the two readers that compile one back. Stripping at the
 * readers too is what makes a lock written by an older compiler safe, since the
 * lock-file format is compat-protected and a `flags: 'g'` entry keeps arriving
 * for the whole 0.x line.
 *
 * Pure string logic with no imports, so it is safe for the browser barrel.
 */

/** Flags that make a `RegExp` carry `lastIndex` between calls. */
const STATEFUL_FLAGS = /[gy]/g;

/**
 * Drop `g` and `y` from a flag string. Every other ECMAScript flag —
 * `d` (hasIndices), `i`, `m`, `s`, `u`, `v` — is meaningful to a single
 * `.test()` and is preserved.
 */
export function stripStatefulRegexFlags(flags: string | undefined): string {
  return (flags ?? '').replace(STATEFUL_FLAGS, '');
}

/**
 * Same, but collapsing an empty result to `undefined` — the shape the SDK's
 * pattern types and the lock file use for "no flags".
 */
export function normalizeRegexFlags(flags: string | undefined): string | undefined {
  return stripStatefulRegexFlags(flags) || undefined;
}
