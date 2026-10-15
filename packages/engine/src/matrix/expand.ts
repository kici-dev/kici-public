/** Single-dimension static matrix: array of values */
export type StaticMatrixArray = string[];

/** Multi-dimensional static matrix: named dimensions with values */
export type StaticMatrixObject = Record<string, string[]>;

/** Include entries for adding specific matrix combinations */
export type MatrixInclude = Record<string, string>;

/** Exclude entries for removing specific matrix combinations */
export type MatrixExclude = Record<string, string>;

/**
 * Matrix values as exposed to steps: `{value: 'linux'}` for a single dimension,
 * `{os: 'linux', node: '18'}` for several.
 */
export interface MatrixValues {
  value?: string;
  [dimension: string]: string | undefined;
}

/**
 * Thrown when a matrix value is not a `string[]` or a `Record<string, string[]>`.
 * The lock-file schema guarantees a static matrix, but a dynamic matrix returns
 * arbitrary runtime data, so the contract is enforced here.
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
 * Validate and normalize a matrix value: the two documented shapes, with
 * numeric and boolean elements coerced to strings (as job names already render
 * them); anything else is rejected with the contract in the message. Dimensions
 * are sorted so expansion stays deterministic.
 */
export function normalizeMatrixInput(input: unknown): NormalizedMatrix {
  if (Array.isArray(input)) {
    // `Array.from` rather than `.map`: `.map` skips holes, so a sparse array
    // would carry `undefined` values straight past the element check.
    return { kind: 'array', values: Array.from(input, (v, i) => coerceElement(v, `values[${i}]`)) };
  }
  if (input === null || typeof input !== 'object') {
    // Name the bare-string trap: `Object.entries('linux')` yields one dimension
    // per character, and expansion then dies on a non-array.
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
  // Without this short-circuit the left-to-right reduce materializes the whole
  // prefix product before an empty set collapses it, so a zero-combination
  // matrix could still exhaust memory.
  if (sets.some((set) => set.length === 0)) {
    return [];
  }
  return sets.reduce<T[][]>(
    (acc, set) => acc.flatMap((tuple) => set.map((value) => [...tuple, value])),
    [[]],
  );
}

/** Expand the array form: each value becomes `{value}`. */
export function expandSingleDimension(matrix: StaticMatrixArray): MatrixValues[] {
  return matrix.map((value) => ({ value }));
}

/** Expand the object form: the cartesian product, dimension names sorted for determinism. */
export function expandMultiDimension(matrix: StaticMatrixObject): MatrixValues[] {
  const dimensions = Object.entries(matrix);

  // Validation should already reject an empty matrix.
  if (dimensions.length === 0) {
    return [];
  }

  dimensions.sort((a, b) => a[0].localeCompare(b[0]));

  const names = dimensions.map(([name]) => name);
  const valueSets = dimensions.map(([, values]) => values);

  const combinations = cartesianProduct(valueSets);

  // `Object.fromEntries` defines own properties; assigning `result['__proto__']`
  // would hit the inherited setter and drop a dimension named `__proto__`.
  return combinations.map(
    (combo) => Object.fromEntries(names.map((name, idx) => [name, combo[idx]])) as MatrixValues,
  );
}

/**
 * Validated entry point: normalizes an untrusted matrix value, then expands it.
 * Use it for anything crossing a runtime boundary, such as a dynamic matrix
 * function's return value; {@link expandSingleDimension} and
 * {@link expandMultiDimension} serve a caller already holding a typed value.
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
 * them, so callers can refuse an oversized matrix before allocating it.
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
 * `keyOf` defines "the same combination". Callers owning a job name key on the
 * expanded name, since two children sharing a name are indistinguishable to an
 * operator and ambiguous as a needs-edge target; structurally different
 * combinations can render the same name, so this is stronger than the default.
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
 * Apply excludes, then includes, to expanded combinations. An exclude matches
 * when ALL its dimensions match; an include adds a combination not already present.
 */
export function applyIncludeExclude(
  expanded: MatrixValues[],
  include?: MatrixInclude[],
  exclude?: MatrixExclude[],
): MatrixValues[] {
  let result = [...expanded];

  // An empty exclude `{}` matches NOTHING, or a conditional spread collapsing to
  // `{}` would silently wipe the whole matrix.
  if (exclude && exclude.length > 0) {
    result = result.filter((combo) => {
      return !exclude.some((excl) => {
        const exclEntries = Object.entries(excl);
        if (exclEntries.length === 0) return false;
        return exclEntries.every(([key, value]) => combo[key] === value);
      });
    });
  }

  // Empty includes are ignored too: `{}` would add a shape-less combination.
  if (include && include.length > 0) {
    for (const incl of include) {
      const inclKeys = Object.keys(incl);
      if (inclKeys.length === 0) continue;

      const exists = result.some((combo) => {
        const comboKeys = Object.keys(combo);
        if (inclKeys.length !== comboKeys.length) return false;
        return inclKeys.every((key) => combo[key] === incl[key]);
      });

      if (!exists) {
        // Key-sorted: `formatMatrixSuffix` renders insertion order, so an
        // author-ordered include would print its dimensions differently from its
        // sorted expanded siblings. A copy: the object becomes a child's
        // `variantValues`, and `incl` is the lock job's own entry.
        // `Object.fromEntries`: loop assignment would hit the inherited
        // `__proto__` setter and drop that dimension, which `JSON.parse` of a
        // lock file can create.
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
