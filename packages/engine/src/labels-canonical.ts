/**
 * The canonical form of a runner label.
 *
 * Label matching folds case. Labels are canonicalized once at each ingress into
 * the matching domain, not at each comparison site, where one forgotten call
 * reintroduces a silent no-match; every comparison downstream is an O(1)
 * `Set.has` over canonical strings.
 *
 * The brand makes the compiler demand the fold at a new ingress: a plain
 * `string` does not satisfy a `CanonicalLabel` parameter. It has no runtime
 * representation.
 *
 * Not applied to `matcherMatches`, which `matchHostPattern` uses to match agent
 * IDs: an agent id is opaque and stays case-sensitive. Hostnames fold (DNS is
 * case-insensitive), but only on the arm that has ruled out the agent-id
 * fallback — see `matchHostPattern`.
 *
 * No imports, so it is safe for the browser barrel.
 */

declare const CANONICAL_LABEL: unique symbol;

/** A label folded to its canonical (trimmed, lowercase) form. */
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
