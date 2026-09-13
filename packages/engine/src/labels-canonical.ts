/**
 * The canonical form of a runner label, and the intended way to produce one.
 *
 * Label matching folds case. Rather than fold at each of the many comparison
 * sites — where one forgotten call reintroduces a silent no-match — labels are
 * canonicalized once at each ingress into the matching domain, and every
 * comparison downstream stays an O(1) `Set.has` over already-canonical strings.
 *
 * The brand is what stops a future ingress from skipping the fold: a plain
 * `string` will not satisfy a `CanonicalLabel` parameter, so the compiler
 * demands the call. It is a type-level marker with no runtime representation.
 *
 * Deliberately NOT applied to `matcherMatches`, which `matchHostPattern` uses
 * to match agent IDs — an agent id is an opaque identifier, not a label, and
 * must stay case-sensitive. Hostnames DO fold (they are case-insensitive by
 * DNS convention), but only on the arm that has ruled out the agent-id
 * fallback — see `matchHostPattern`.
 *
 * Pure string logic with no imports, so it is safe for the browser barrel.
 */

declare const CANONICAL_LABEL: unique symbol;

/** A label that has been folded to its canonical (lowercase) form. */
export type CanonicalLabel = string & { readonly [CANONICAL_LABEL]: true };

/** Fold one label to canonical form. Idempotent. */
export function canonicalizeLabel(raw: string): CanonicalLabel {
  return raw.trim().toLowerCase() as CanonicalLabel;
}

/**
 * Fold a list, preserving order and length. Case-only duplicates survive as
 * duplicates — use {@link canonicalizeLabelSet} when they should collapse.
 */
export function canonicalizeLabels(raw: readonly string[]): CanonicalLabel[] {
  return raw.map(canonicalizeLabel);
}

/** Fold into a Set, collapsing case-only duplicates. */
export function canonicalizeLabelSet(raw: readonly string[]): Set<CanonicalLabel> {
  return new Set(raw.map(canonicalizeLabel));
}
