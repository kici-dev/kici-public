/**
 * The one definition of which regex flags may survive into a compiled matcher.
 *
 * `g` and `y` make a `RegExp` stateful: it carries `lastIndex` across `.test()`
 * calls, so a memoized one alternates verdicts for the same input and a loop
 * over a set resumes mid-string on the second element. Every matcher here is
 * memoized (`trigger/compiled-matchers.ts`, `labels-match.ts`) or applied to a
 * set (`matcherSatisfiedBy`), and each asks one yes/no question of a whole
 * string.
 *
 * So both flags are dropped at every boundary: the SDK producers that read an
 * author's `RegExp`, the compiler that serializes it, and the readers that
 * compile it back. Stripping at the readers keeps locks from older compilers
 * safe: the lock-file format is compat-protected, so `flags: 'g'` entries keep
 * arriving for the whole 0.x line.
 *
 * Pure string logic with no imports, so it is safe for the browser barrel.
 */

/** Flags that make a `RegExp` carry `lastIndex` between calls. */
const STATEFUL_FLAGS = /[gy]/g;

/** Drop `g` and `y`; every other flag (`d`, `i`, `m`, `s`, `u`, `v`) is preserved. */
export function stripStatefulRegexFlags(flags: string | undefined): string {
  return (flags ?? '').replace(STATEFUL_FLAGS, '');
}

/**
 * {@link stripStatefulRegexFlags}, collapsing an empty result to `undefined`:
 * the SDK pattern types' and the lock file's "no flags".
 */
export function normalizeRegexFlags(flags: string | undefined): string | undefined {
  return stripStatefulRegexFlags(flags) || undefined;
}
