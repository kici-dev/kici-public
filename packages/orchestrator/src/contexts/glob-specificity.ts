/**
 * Specificity scoring for glob environment patterns.
 *
 * Used to resolve which glob context governs a run when an environment name
 * matches more than one pattern. The most-specific pattern (most literal
 * characters) wins; ties break toward fewer wildcards, then name ascending —
 * a total, deterministic order.
 */

// Characters that picomatch treats as glob syntax rather than literals.
const GLOB_META = new Set<string>([...'*?[]{}()!|+@']);

export interface GlobSpecificity {
  /** Count of characters that are NOT glob metacharacters. Higher = more specific. */
  literals: number;
  /** Count of characters that ARE glob metacharacters. Lower = more specific. */
  wildcards: number;
}

export function globSpecificityScore(pattern: string): GlobSpecificity {
  let literals = 0;
  let wildcards = 0;
  for (const ch of pattern) {
    if (GLOB_META.has(ch)) wildcards++;
    else literals++;
  }
  return { literals, wildcards };
}

/**
 * Compares two glob contexts, ranking the more specific first.
 * Returns <0 when `a` is more specific than `b`, >0 when less, 0 only when
 * pattern-score and name are identical.
 *
 * Order: literals desc, then wildcards asc, then name asc.
 */
export function compareGlobSpecificity(
  a: { pattern: string; name: string },
  b: { pattern: string; name: string },
): number {
  const sa = globSpecificityScore(a.pattern);
  const sb = globSpecificityScore(b.pattern);
  if (sa.literals !== sb.literals) return sb.literals - sa.literals; // more literals first
  if (sa.wildcards !== sb.wildcards) return sa.wildcards - sb.wildcards; // fewer wildcards first
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; // name asc, total order
}
