/**
 * The one classifier for "picomatch would read this repo pattern as a
 * negation".
 *
 * Repo patterns are written on lists whose direction is already fixed by the
 * list itself — a role's allowed repositories, a global-workflow allow list, a
 * global-workflow deny list. A pattern picomatch reads as a negation inverts
 * that direction inside a single entry, so an entry that reads as a restriction
 * matches as its complement. On an allow list that grants almost everything; on
 * a deny list it admits the one repository the entry named.
 *
 * This lives in the engine, and not beside either consumer, because two
 * hand-maintained ban lists for one pattern language cannot be kept in step.
 * The two ways they drift apart are both live hazards: a list that misses the
 * regular-expression assertions accepts a real inversion, and a list that
 * refuses `[!…]` turns away a genuine restriction. Every surface that stores a
 * repo pattern reads its verdict from here, so neither can happen on one
 * surface alone.
 */

/**
 * The regular-expression negations picomatch passes through into the compiled
 * matcher: the negative lookahead `(?!…)` and the negative lookbehind `(?<!…)`.
 * The optional `<` is what makes one pattern cover both; the positive `(?=…)`,
 * `(?<=…)`, `(?:…)` and a plain capture group are deliberately not matched.
 */
export const REGEX_NEGATIVE_ASSERTION = /\(\?<?!/;

/**
 * Why picomatch would read `pattern` as a negation, or null when it would not.
 *
 * Four arms, because picomatch reads four negation forms, each of which turns a
 * pattern that reads as a restriction into a grant.
 *
 * A leading `!` negates the whole pattern. The extglob complement `!(…)`
 * negates wherever it appears, so `org/!(secret)` covers every repository under
 * `org/` except that one — the same defect in a prefix-scoped shape. The
 * negated character class `[^…]` does it one character at a time: `org/[^s]*`
 * covers every repository under `org/` whose name does not begin with `s`. The
 * negative assertions are the widest of the four, because they can spell a
 * whole repository identifier rather than one character: picomatch compiles a
 * pattern to a regular expression and passes a group it does not recognise
 * through verbatim, so `(?!org/secret)**` reaches the matcher as a real
 * lookahead and matches every repository in every organization except the one
 * it names.
 *
 * The extglob arm matches the two-character sequence `!(` and nothing wider:
 * `*(`, `+(`, `@(` and `?(` are the non-complementing extglob heads and do not
 * invert, so rejecting a bare `(` would refuse four harmless forms for no gain.
 * A `(` cannot appear in a repository identifier, so no legitimate pattern
 * contains `!(`. The assertion arm is narrow for the same reason: `(?=…)`,
 * `(?<=…)`, `(?:…)` and a plain capture group match strictly what they name, so
 * only the two negative forms are refused.
 *
 * The character-class arm matches `[^` and nothing wider: a `[` cannot appear
 * in a repository identifier either, and a bracket that is not a negation —
 * `org/[abc]*` — is a legitimate restriction. It matches `[^` and NOT `[!`:
 * picomatch does not read `[!…]` as the POSIX negation. It reads it as a
 * literal class containing `!` and the listed characters, so `org/[!s]*`
 * matches exactly the repositories whose name begins with `!` or `s` — the
 * exact inverse of `org/[^s]*`, and a genuine restriction. Rejecting it would
 * refuse a pattern that grants strictly less than it names while leaving the
 * real inversion open.
 *
 * A bare `!` is different — it *can* appear in a repository name — so the first
 * arm stays anchored: `org/we!rd` is a legitimate literal, and an
 * `includes('!')` check would silently reject a valid repository name.
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
