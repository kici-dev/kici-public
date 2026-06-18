/** Single-dimension static matrix: array of values */
export type StaticMatrixArray = string[];

/** Multi-dimensional static matrix: named dimensions with values */
export type StaticMatrixObject = Record<string, string[]>;

/** Include entries for adding specific matrix combinations */
export type MatrixInclude = Record<string, string>;

/** Exclude entries for removing specific matrix combinations */
export type MatrixExclude = Record<string, string>;

/**
 * Matrix values as exposed to steps.
 * Single-dimension: {value: 'linux'}
 * Multi-dimensional: {os: 'linux', node: '18'}
 */
export interface MatrixValues {
  /** Single-dimension: the value */
  value?: string;
  /** Multi-dimensional: named properties */
  [dimension: string]: string | undefined;
}

/**
 * Compute the cartesian product of the given value sets in row-major order.
 * An empty set list yields a single empty tuple; any empty set yields no tuples.
 */
export function cartesianProduct<T>(sets: T[][]): T[][] {
  return sets.reduce<T[][]>(
    (acc, set) => acc.flatMap((tuple) => set.map((value) => [...tuple, value])),
    [[]],
  );
}

/**
 * Expand single-dimension matrix (array form) to MatrixValues array.
 * Each value becomes {value: string}.
 */
export function expandSingleDimension(matrix: StaticMatrixArray): MatrixValues[] {
  return matrix.map((value) => ({ value }));
}

/**
 * Expand multi-dimensional matrix (object form) to MatrixValues array.
 * Computes the cartesian product of all dimensions.
 * Dimension names are sorted for deterministic output.
 */
export function expandMultiDimension(matrix: StaticMatrixObject): MatrixValues[] {
  const dimensions = Object.entries(matrix);

  // Handle empty (should be caught by validation, but defensive)
  if (dimensions.length === 0) {
    return [];
  }

  // Sort dimension names for deterministic output
  dimensions.sort((a, b) => a[0].localeCompare(b[0]));

  const names = dimensions.map(([name]) => name);
  const valueSets = dimensions.map(([, values]) => values);

  // Generate cartesian product
  const combinations = cartesianProduct(valueSets);

  // Map back to named properties
  return combinations.map((combo) => {
    const result: MatrixValues = {};
    names.forEach((name, idx) => {
      result[name] = combo[idx];
    });
    return result;
  });
}

/**
 * Unified expand function that dispatches to single or multi-dimensional expansion.
 */
export function expandMatrix(matrix: StaticMatrixArray | StaticMatrixObject): MatrixValues[] {
  if (Array.isArray(matrix)) {
    return expandSingleDimension(matrix);
  }
  return expandMultiDimension(matrix);
}

/**
 * Apply include/exclude modifications to expanded matrix combinations.
 * Exclude first (remove matching), then include (add new).
 *
 * Exclude matches if ALL specified dimensions match.
 * Include adds new combinations if they don't already exist.
 */
export function applyIncludeExclude(
  expanded: MatrixValues[],
  include?: MatrixInclude[],
  exclude?: MatrixExclude[],
): MatrixValues[] {
  let result = [...expanded];

  // Apply excludes first (remove matching combinations).
  // An empty exclude entry `{}` must match NOTHING (not everything) — otherwise
  // a conditional spread that collapses to `{}` silently wipes the whole matrix.
  if (exclude && exclude.length > 0) {
    result = result.filter((combo) => {
      return !exclude.some((excl) => {
        const exclEntries = Object.entries(excl);
        if (exclEntries.length === 0) return false;
        return exclEntries.every(([key, value]) => combo[key] === value);
      });
    });
  }

  // Apply includes (add new combinations). Empty include entries are ignored
  // for the same reason: `{}` would add a shape-less combination to the matrix.
  if (include && include.length > 0) {
    for (const incl of include) {
      const inclKeys = Object.keys(incl);
      if (inclKeys.length === 0) continue;

      // Check if this exact combination already exists
      const exists = result.some((combo) => {
        const comboKeys = Object.keys(combo);
        if (inclKeys.length !== comboKeys.length) return false;
        return inclKeys.every((key) => combo[key] === incl[key]);
      });

      if (!exists) {
        result.push(incl as MatrixValues);
      }
    }
  }

  return result;
}
