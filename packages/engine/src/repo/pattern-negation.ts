/**
 * The one classifier for "picomatch would read this repo pattern as a
 * negation".
 *
 * Repo patterns sit on lists whose direction the list fixes (a role's allowed
 * repositories, a global-workflow allow or deny list). A negation inverts that
 * direction inside one entry, so a restriction matches as its complement: on an
 * allow list it grants almost everything, on a deny list it admits the one
 * repository it named.
 *
 * It lives in the engine because two hand-maintained ban lists for one pattern
 * language drift apart: one that misses the regex assertions accepts a real
 * inversion, one that refuses `[!…]` turns away a genuine restriction. Every
 * surface that stores a repo pattern reads its verdict from here.
 */

/**
 * The regex negations picomatch passes through into the compiled matcher: the
 * negative lookahead `(?!…)` and lookbehind `(?<!…)` (the optional `<`). The
 * positive `(?=…)`, `(?<=…)`, `(?:…)` and a plain capture group are
 * deliberately not matched.
 */
export const REGEX_NEGATIVE_ASSERTION = /\(\?<?!/;

/**
 * Why picomatch would read `pattern` as a negation, or null when it would not.
 * Each negation form picomatch reads turns a restriction into a grant:
 *
 * - A leading `!` negates the whole pattern. It stays anchored because a bare
 *   `!` can appear in a repository name: an `includes('!')` check would reject
 *   the valid `org/we!rd`.
 * - The extglob complement `!(…)` negates wherever it appears:
 *   `org/!(secret)` covers every repository under `org/` except that one. Only
 *   `!(` is matched; `*(`, `+(`, `@(` and `?(` do not invert, and a `(` cannot
 *   appear in a repository identifier, so no legitimate pattern contains `!(`.
 * - The negated class `[^…]` negates per character: `org/[^s]*` covers every
 *   repository under `org/` not starting with `s`. `[!` is NOT matched:
 *   picomatch reads `[!…]` as a literal class containing `!`, so `org/[!s]*`
 *   matches only names starting with `!` or `s`, a genuine restriction; banning
 *   `[!` instead of `[^` would refuse it and leave the real inversion open.
 *   A `[` cannot appear in a repository identifier, and a non-negated bracket
 *   (`org/[abc]*`) is legitimate.
 * - The negative assertions are the widest, spelling a whole identifier:
 *   picomatch passes an unrecognised group through verbatim, so
 *   `(?!org/secret)**` matches every repository in every organization except
 *   that one. The positive groups match strictly what they name and are allowed.
 */
export function negatedPatternReason(pattern: string): string | null {
  if (pattern.startsWith('!')) {
    return "negation ('!' prefix)";
  }
  if (pattern.includes('!(')) {
    return "extglob negation ('!(…)')";
  }
  if (pattern.includes('[^')) {
    return "character-class negation ('[^…]')";
  }
  if (REGEX_NEGATIVE_ASSERTION.test(pattern)) {
    return "negative assertion ('(?!…)' / '(?<!…)')";
  }
  return null;
}

/**
 * True when `pattern` is a picomatch negation — whole-pattern `!…`, extglob
 * `!(…)`, negated character class `[^…]`, or a negative lookahead / lookbehind.
 */
export function isNegatedPattern(pattern: string): boolean {
  return negatedPatternReason(pattern) !== null;
}
