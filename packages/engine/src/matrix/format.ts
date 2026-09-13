import type { MatrixValues } from './expand.js';

/**
 * Format matrix values into a display string for the job name.
 * Single-dimension: "node-18"
 * Multi-dimensional: "linux, 18"
 */
export function formatMatrixSuffix(matrixValues: MatrixValues): string {
  const defined = Object.entries(matrixValues).filter(([, v]) => v !== undefined);
  // Single-dimension matrices are represented as `{ value: X }`, so render just
  // the value. Only treat `value` as the single-dimension sentinel when it is
  // the SOLE dimension — a multi-dimensional matrix may legitimately name a
  // dimension `value`, and collapsing such a combination to just that dimension
  // would drop the other dimensions from the job name and collide sibling
  // combinations onto the same expanded name.
  if (defined.length === 1 && defined[0][0] === 'value') {
    return defined[0][1] as string;
  }
  return defined.map(([, v]) => v).join(', ');
}

/**
 * Expanded child job name: `${baseName} (${suffix})`. The `(...)` wrapper is
 * load-bearing, not decoration: `variantLabelOf` (fanout/materialize.ts) and
 * `buildMatrixOutputsEnvelope` (the orchestrator's `byMatrix` key) both recover
 * the suffix by slicing it back out of the name.
 */
export function formatExpandedJobName(baseName: string, matrixValues: MatrixValues): string {
  return `${baseName} (${formatMatrixSuffix(matrixValues)})`;
}
