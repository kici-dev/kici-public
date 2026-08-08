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
 * Thrown when a matrix value does not match the documented contract — a
 * `string[]` or a `Record<string, string[]>`. A static matrix is guaranteed by
 * the lock-file schema, but a dynamic matrix returns arbitrary runtime data, so
 * the contract has to be enforced here rather than by the type system.
 */
export class MatrixShapeError extends Error {
  override readonly name = 'MatrixShapeError';
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, MatrixShapeError.prototype);
  }
}

/** A validated matrix input: dimensions sorted, elements coerced to strings. */
export type NormalizedMatrix =
  | { kind: 'array'; values: string[] }
  | { kind: 'object'; dimensions: Array<[name: string, values: string[]]> };

/** Describe a rejected value for an error message, without dumping it wholesale. */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `a string (${JSON.stringify(value)})`;
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}

/** Coerce one matrix element, rejecting anything that has no sensible string form. */
function coerceElement(value: unknown, where: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new MatrixShapeError(`matrix ${where} must contain strings, got ${describeValue(value)}`);
}

/**
 * Validate and normalize a matrix value. Accepts the two documented shapes,
 * coercing numeric and boolean elements to strings (they already reach job
 * names as strings), and rejects everything else with the contract in the
 * message. Dimensions are sorted here so expansion stays deterministic.
 */
export function normalizeMatrixInput(input: unknown): NormalizedMatrix {
  if (Array.isArray(input)) {
    // `Array.from` rather than `.map`: `.map` skips holes, so a sparse array
    // would carry `undefined` values straight past the element check.
    return { kind: 'array', values: Array.from(input, (v, i) => coerceElement(v, `values[${i}]`)) };
  }
  if (input === null || typeof input !== 'object') {
    // A bare string is the trap worth naming: `Object.entries('linux')` yields
    // one dimension per character, and expansion then dies on a character that
    // is not an array. Point the author at the split they forgot.
    const suffix =
      typeof input === 'string'
        ? ' — a bare string is read as one dimension per character; split it into an array'
        : '';
    throw new MatrixShapeError(
      `matrix must be a string array or an object of string arrays, got ${describeValue(input)}${suffix}`,
    );
  }
  const dimensions: Array<[string, string[]]> = [];
  for (const [name, values] of Object.entries(input as Record<string, unknown>)) {
    if (!Array.isArray(values)) {
      throw new MatrixShapeError(
        `matrix dimension "${name}" must be an array, got ${describeValue(values)}`,
      );
    }
    dimensions.push([
      name,
      Array.from(values, (v, i) => coerceElement(v, `dimension "${name}"[${i}]`)),
    ]);
  }
  dimensions.sort((a, b) => a[0].localeCompare(b[0]));
  return { kind: 'object', dimensions };
}

/**
 * Compute the cartesian product of the given value sets in row-major order.
 * An empty set list yields a single empty tuple; any empty set yields no tuples.
 */
export function cartesianProduct<T>(sets: T[][]): T[][] {
  // Short-circuit on an empty set before reducing. The reduce is left-to-right,
  // so without this it materializes the whole prefix product before the empty
  // set collapses the result to nothing — which is how a matrix whose combination
  // count is 0 could still exhaust memory on the way to producing `[]`.
  if (sets.some((set) => set.length === 0)) {
    return [];
  }
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

  // Map back to named properties. `Object.fromEntries` defines own properties;
  // assigning `result['__proto__']` in a loop would instead hit the inherited
  // setter and silently drop a dimension named `__proto__`.
  return combinations.map(
    (combo) => Object.fromEntries(names.map((name, idx) => [name, combo[idx]])) as MatrixValues,
  );
}

/**
 * Validated entry point: normalizes an untrusted matrix value, then dispatches
 * to single- or multi-dimensional expansion. {@link expandSingleDimension} and
 * {@link expandMultiDimension} remain available for a caller that already holds
 * a typed value; this is the one to use for anything crossing a runtime
 * boundary, such as the return value of a dynamic matrix function.
 */
export function expandMatrix(input: unknown): MatrixValues[] {
  const normalized = normalizeMatrixInput(input);
  if (normalized.kind === 'array') {
    return expandSingleDimension(normalized.values);
  }
  return expandMultiDimension(Object.fromEntries(normalized.dimensions));
}

/**
 * How many combinations a matrix would expand to, computed WITHOUT building
 * them. Callers use this to refuse an oversized matrix before allocating it —
 * the product is checked, never materialized.
 */
export function matrixCombinationCount(input: unknown): number {
  const normalized = normalizeMatrixInput(input);
  if (normalized.kind === 'array') {
    return normalized.values.length;
  }
  if (normalized.dimensions.length === 0) {
    return 0;
  }
  return normalized.dimensions.reduce((acc, [, values]) => acc * values.length, 1);
}

/** Stable identity for a combination: its key/value pairs, key-sorted. */
function combinationKey(combo: MatrixValues): string {
  return JSON.stringify(
    Object.entries(combo)
      .filter(([, value]) => value !== undefined)
      .sort((a, b) => a[0].localeCompare(b[0])),
  );
}

/**
 * The first combination whose key collides with an earlier one, or `null` when
 * every combination is distinct.
 *
 * `keyOf` decides what "the same combination" means. Callers that own a job name
 * pass a renderer for the expanded name, because the collision that actually
 * hurts is two children sharing a name — they are indistinguishable to an
 * operator and ambiguous as a needs-edge target. Two structurally different
 * combinations can still render the same name, so name-keying is strictly
 * stronger than the structural default.
 */
export function findDuplicateCombination(
  combos: readonly MatrixValues[],
  keyOf: (combo: MatrixValues) => string = combinationKey,
): MatrixValues | null {
  const seen = new Set<string>();
  for (const combo of combos) {
    const key = keyOf(combo);
    if (seen.has(key)) return combo;
    seen.add(key);
  }
  return null;
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
        // Key-sorted copy, for two reasons. Order: `expandMultiDimension` sorts
        // dimension names but an include entry carries the author's key order,
        // and `formatMatrixSuffix` renders insertion order — so an unsorted
        // include child prints its dimensions in a different order than every
        // expanded sibling. Copy: the pushed object becomes a child job's
        // `variantValues`, so pushing `incl` itself hands out a live reference
        // to the lock job's own include entry. `Object.fromEntries` rather than
        // assignment in a loop: `sorted['__proto__'] = v` runs the inherited
        // setter instead of defining an own property, so a dimension named
        // `__proto__` (which `JSON.parse` of a lock file does create) would be
        // dropped from the combination.
        result.push(
          Object.fromEntries(
            [...inclKeys].sort((a, b) => a.localeCompare(b)).map((key) => [key, incl[key]]),
          ) as MatrixValues,
        );
      }
    }
  }

  return result;
}
