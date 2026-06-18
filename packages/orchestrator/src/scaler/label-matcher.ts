/**
 * Label-set matching and overlap detection for the scaler module.
 *
 * Label sets are normalized (sorted, deduplicated, lowercased) for
 * deterministic comparison.
 *
 * findBackendForLabels uses subset matching: a job requiring ['macos']
 * matches a scaler with ['macos', 'darwin', 'bare-metal']. This is
 * consistent with peer routing (findPeersWithCapacity) and allows
 * workflows to target broad labels like 'macos' without listing every
 * label the scaler defines.
 */

/**
 * Normalize a label set for comparison.
 * Sorts alphabetically, deduplicates, and lowercases all labels.
 * Produces a deterministic string key for comparison.
 *
 * @example
 * normalizeLabelSet(['Docker', 'linux', 'linux']) // => "docker,linux"
 * normalizeLabelSet([]) // => ""
 */
export function normalizeLabelSet(labels: string[]): string {
  return [...new Set(labels.map((l) => l.toLowerCase()))].sort().join(',');
}

/**
 * Check if two label sets are exactly equal after normalization.
 * Subsets do NOT match -- ["linux"] does not match ["linux", "docker"].
 */
export function labelSetsMatch(a: string[], b: string[]): boolean {
  return normalizeLabelSet(a) === normalizeLabelSet(b);
}

/**
 * Detect overlapping label sets across different scalers.
 * Returns all pairs of scalers that share the same normalized label set.
 *
 * Intra-scaler duplicates are allowed (same scaler, duplicate label sets).
 * Only cross-scaler overlaps are flagged.
 *
 * Used at startup to reject configs with ambiguous routing.
 */
export function detectLabelSetOverlaps(
  scalers: Array<{ name: string; labelSets: Array<{ labels: string[] }> }>,
): Array<{ labels: string; scaler1: string; scaler2: string }> {
  const overlaps: Array<{ labels: string; scaler1: string; scaler2: string }> = [];

  // Map: normalized label set -> first scaler name that owns it
  const seen = new Map<string, string>();

  for (const scaler of scalers) {
    for (const ls of scaler.labelSets) {
      const normalized = normalizeLabelSet(ls.labels);
      const existing = seen.get(normalized);

      if (existing !== undefined && existing !== scaler.name) {
        overlaps.push({
          labels: normalized,
          scaler1: existing,
          scaler2: scaler.name,
        });
      } else if (existing === undefined) {
        seen.set(normalized, scaler.name);
      }
    }
  }

  return overlaps;
}

/**
 * Find which scaler backend handles a given set of labels.
 * Returns the scaler name and label-set index, or null if no match.
 *
 * Uses subset matching: job labels must be a subset of the scaler's label set.
 * ['macos'] matches ['macos', 'darwin', 'bare-metal']. This is consistent
 * with peer routing (findPeersWithCapacity) which uses the same semantics.
 *
 * In addition, every label declared in a scaler's `mandatoryLabels` must be
 * present in the job's `runsOn`. This is the Kubernetes-taint-style opt-in
 * gate: a scaler with `mandatoryLabels: ['gpu']` only accepts jobs that
 * explicitly include `gpu` in `runsOn`.
 *
 * When multiple backends match, the one with the smallest label set wins
 * (most specific match).
 */
export function findBackendForLabels(
  labels: string[],
  scalers: Array<{
    name: string;
    labelSets: Array<{ labels: string[] }>;
    mandatoryLabels?: string[];
  }>,
  excludeLabels: string[] = [],
): { scalerName: string; labelSetIndex: number } | null {
  const targetLabels = new Set(labels.map((l) => l.toLowerCase()));

  // Empty target matches the first scaler whose mandatoryLabels are empty.
  // A scaler with any mandatoryLabel cannot accept an empty runsOn because
  // the gate label cannot be present.
  if (targetLabels.size === 0) {
    for (const scaler of scalers) {
      if ((scaler.mandatoryLabels?.length ?? 0) > 0) continue;
      if (scaler.labelSets.length > 0) {
        return { scalerName: scaler.name, labelSetIndex: 0 };
      }
    }
    return null;
  }

  let bestMatch: { scalerName: string; labelSetIndex: number; size: number } | null = null;

  for (const scaler of scalers) {
    // Mandatory-labels gate: every label in scaler.mandatoryLabels must be
    // present in the job's targetLabels. Mandatory labels are scaler-level,
    // so we check once per scaler before scanning its labelSets.
    const mandatory = scaler.mandatoryLabels ?? [];
    if (mandatory.length > 0) {
      const allMandatoryPresent = mandatory.every((m) => targetLabels.has(m.toLowerCase()));
      if (!allMandatoryPresent) continue;
    }

    for (let i = 0; i < scaler.labelSets.length; i++) {
      const scalerLabels = new Set(scaler.labelSets[i].labels.map((l) => l.toLowerCase()));

      // Check: every required label exists in the scaler's label set
      let allMatch = true;
      for (const label of targetLabels) {
        if (!scalerLabels.has(label)) {
          allMatch = false;
          break;
        }
      }

      if (allMatch) {
        // Check exclusion labels: skip backends whose label set contains any excluded label
        if (excludeLabels.length > 0) {
          const hasExcluded = excludeLabels.some((e) => scalerLabels.has(e.toLowerCase()));
          if (hasExcluded) continue;
        }

        if (bestMatch === null || scalerLabels.size < bestMatch.size) {
          bestMatch = { scalerName: scaler.name, labelSetIndex: i, size: scalerLabels.size };
        }
      }
    }
  }

  return bestMatch
    ? { scalerName: bestMatch.scalerName, labelSetIndex: bestMatch.labelSetIndex }
    : null;
}
