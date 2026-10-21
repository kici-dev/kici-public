/**
 * Scaler label-set matching and overlap detection. Subset matching lets a
 * workflow target a broad label like 'macos' without listing every label the
 * scaler defines.
 */

/**
 * A label set as a deterministic comparison key: lowercased, deduplicated, sorted.
 *
 * @example
 * normalizeLabelSet(['Docker', 'linux', 'linux']) // => "docker,linux"
 * normalizeLabelSet([]) // => ""
 */
export function normalizeLabelSet(labels: string[]): string {
  return [...new Set(labels.map((l) => l.toLowerCase()))].sort().join(',');
}

/**
 * Exact equality after normalization; a subset does NOT match.
 */
export function labelSetsMatch(a: string[], b: string[]): boolean {
  return normalizeLabelSet(a) === normalizeLabelSet(b);
}

/**
 * Every pair of scalers sharing a normalized label set. A duplicate within one
 * scaler is allowed. Startup rejects a config with an overlap: its routing is
 * ambiguous.
 */
export function detectLabelSetOverlaps(
  scalers: Array<{ name: string; labelSets: Array<{ labels: string[] }> }>,
): Array<{ labels: string; scaler1: string; scaler2: string }> {
  const overlaps: Array<{ labels: string; scaler1: string; scaler2: string }> = [];

  // normalized label set -> the first scaler that owns it
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
 * The taint gate for one label set, from the index-aligned
 * `labelSetMandatoryLabels`; no array means ungated. `null` when the array's
 * length differs from `labelSets`: indexing a misaligned array would apply one
 * set's gate to another, so no label set of that scaler is routable.
 */
function gateForLabelSet(
  scaler: {
    labelSets: Array<{ labels: string[] }>;
    labelSetMandatoryLabels?: string[][];
  },
  index: number,
): string[] | null {
  const perSet = scaler.labelSetMandatoryLabels;
  if (perSet === undefined) return [];
  if (perSet.length !== scaler.labelSets.length) return null;
  return perSet[index] ?? [];
}

/**
 * The lowercased labels of label set `index` when it can take a job whose exact
 * labels are `target`: its gate is satisfied and it carries every target label.
 * `null` otherwise.
 */
function acceptingLabelSet(
  scaler: {
    labelSets: Array<{ labels: string[] }>;
    labelSetMandatoryLabels?: string[][];
  },
  index: number,
  target: ReadonlySet<string>,
): Set<string> | null {
  // Per set, not per scaler: a scaler mixing platforms gates each set
  // differently, and a scaler-level check tests the union and rejects every set.
  const mandatory = gateForLabelSet(scaler, index);
  if (mandatory === null) return null;
  if (!mandatory.every((m) => target.has(m.toLowerCase()))) return null;
  const scalerLabels = new Set(scaler.labelSets[index].labels.map((l) => l.toLowerCase()));
  for (const label of target) {
    if (!scalerLabels.has(label)) return null;
  }
  return scalerLabels;
}

/**
 * The scaler and label-set index that handle a job's labels, or null.
 *
 * Subset matching: ['macos'] matches ['macos', 'darwin', 'bare-metal'], the same
 * semantics as peer routing (findPeersWithCapacity). Every label in the
 * matched set's gate must also be in `runsOn` (a Kubernetes-taint-style
 * opt-in: a set gated on `['gpu']` accepts only jobs naming `gpu`). Among
 * several matches the smallest label set wins.
 */
export function findBackendForLabels(
  labels: string[],
  scalers: Array<{
    name: string;
    labelSets: Array<{ labels: string[] }>;
    labelSetMandatoryLabels?: string[][];
  }>,
  excludeLabels: string[] = [],
): { scalerName: string; labelSetIndex: number } | null {
  const targetLabels = new Set(labels.map((l) => l.toLowerCase()));

  // Empty target matches the first label set with no gate. A gated label set
  // cannot accept an empty runsOn because the gate label cannot be present.
  if (targetLabels.size === 0) {
    for (const scaler of scalers) {
      for (let i = 0; i < scaler.labelSets.length; i++) {
        if (gateForLabelSet(scaler, i)?.length === 0) {
          return { scalerName: scaler.name, labelSetIndex: i };
        }
      }
    }
    return null;
  }

  let bestMatch: { scalerName: string; labelSetIndex: number; size: number } | null = null;

  for (const scaler of scalers) {
    for (let i = 0; i < scaler.labelSets.length; i++) {
      const scalerLabels = acceptingLabelSet(scaler, i, targetLabels);
      if (!scalerLabels) continue;
      if (excludeLabels.some((e) => scalerLabels.has(e.toLowerCase()))) continue;
      if (bestMatch === null || scalerLabels.size < bestMatch.size) {
        bestMatch = { scalerName: scaler.name, labelSetIndex: i, size: scalerLabels.size };
      }
    }
  }

  return bestMatch
    ? { scalerName: bestMatch.scalerName, labelSetIndex: bestMatch.labelSetIndex }
    : null;
}

/**
 * Every label set a job whose exact labels are `labels` could be spawned from:
 * each one {@link findBackendForLabels} could pick once the job's exclusions or
 * extra labels (a runtime label its shape demands) narrow the choice. A
 * superset of that pick, for a caller that must not guess which one it is.
 */
export function findEligibleBackendsForLabels(
  labels: string[],
  scalers: Array<{
    name: string;
    labelSets: Array<{ labels: string[] }>;
    labelSetMandatoryLabels?: string[][];
  }>,
): Array<{ scalerName: string; labelSetIndex: number }> {
  const targetLabels = new Set(labels.map((l) => l.toLowerCase()));
  const eligible: Array<{ scalerName: string; labelSetIndex: number }> = [];
  for (const scaler of scalers) {
    for (let i = 0; i < scaler.labelSets.length; i++) {
      if (acceptingLabelSet(scaler, i, targetLabels)) {
        eligible.push({ scalerName: scaler.name, labelSetIndex: i });
      }
    }
  }
  return eligible;
}
