/**
 * Predicate + projection evaluation for the shared `createMockDb` harness.
 *
 * Kept BYTE-IDENTICAL in two places —
 * `packages/orchestrator/src/__test-helpers__/mock-db-query.ts` and
 * `packages/platform/src/__test-helpers__/mock-db-query.ts`. Each package owns an
 * independent `createMockDb` builder and neither package may import the other, so
 * the evaluator is duplicated rather than shared. `mock-db-mirror.test.ts` in both
 * packages fails the moment the copies diverge.
 *
 * `createMockDb` used to return its configured rows verbatim, whatever the
 * query asked for: a `.where(...)` or a `.select([...])` was recorded on a spy
 * and then discarded. A test therefore observed only the rows it had itself
 * configured, so dropping a filter or a projected column from the code under
 * test changed nothing the test could see. This module is the evaluator that
 * closes that: the mock now *applies* the query it was handed.
 *
 * Scope, stated precisely because the guarantee is partial by construction:
 *
 * - **Binary predicates are evaluated.** `.where(column, op, value)` for the
 *   operators in {@link MockDbOperator}. That is the overwhelming majority of
 *   the predicates this repo issues.
 * - **Anything else is opaque and is NOT evaluated.** An expression-builder
 *   callback (`.where((eb) => …)`) and a raw `sql` fragment carry their meaning
 *   in code the mock cannot read, so they are recorded and skipped. A filter
 *   written in one of those shapes is still unpinned.
 * - **A predicate on a column the fixture row does not declare is NOT
 *   evaluated.** The fixture, not the schema, is the source of truth here: a
 *   test row is a partial literal, and a missing key means "this test did not
 *   model that column", not "this column is NULL". Treating absence as NULL
 *   would fail nearly every fixture in the repo for saying too little, while
 *   catching nothing a fixture that *does* declare the column would not
 *   already catch. The consequence is real and worth naming: to pin a filter,
 *   a fixture row must mention the column that filter reads.
 *
 * Everything here is pure — no vitest, no chain state — so it is unit-tested
 * directly in `mock-db-query.test.ts` rather than only through the mock.
 */

/** SQL comparison operators the mock evaluates. Anything else is opaque. */
export enum MockDbOperator {
  eq = '=',
  neq = '!=',
  neqAnsi = '<>',
  lt = '<',
  lte = '<=',
  gt = '>',
  gte = '>=',
  in = 'in',
  notIn = 'not in',
  is = 'is',
  isNot = 'is not',
  like = 'like',
  notLike = 'not like',
  ilike = 'ilike',
  notILike = 'not ilike',
}

const OPERATORS: ReadonlySet<string> = new Set(Object.values(MockDbOperator));

/** A `.where(column, op, value)` predicate the mock can evaluate. */
export interface BinaryPredicate {
  kind: 'binary';
  /** Column name with any `table.` qualifier stripped. */
  column: string;
  op: MockDbOperator;
  value: unknown;
}

/** A predicate shape the mock cannot read (eb callback, raw sql, unknown op). */
export interface OpaquePredicate {
  kind: 'opaque';
  /** Why it could not be parsed — surfaced in `explainSkippedPredicates`. */
  reason: string;
}

export type MockDbPredicate = BinaryPredicate | OpaquePredicate;

/** Drop a `table.` / `"table".` qualifier so a predicate keys into a flat row. */
export function unqualify(column: string): string {
  const dot = column.lastIndexOf('.');
  const bare = dot === -1 ? column : column.slice(dot + 1);
  return bare.replace(/^"|"$/g, '');
}

/**
 * Parse the arguments of one `.where(...)` call into a predicate.
 *
 * Only the 3-argument `(column, op, value)` form with a string column and a
 * recognized operator is evaluable; everything else is opaque.
 */
export function parseWhereArgs(args: readonly unknown[]): MockDbPredicate {
  if (args.length !== 3) {
    return { kind: 'opaque', reason: `where() with ${args.length} argument(s)` };
  }
  const [column, op, value] = args;
  if (typeof column !== 'string') {
    return { kind: 'opaque', reason: 'where() column is not a plain string' };
  }
  if (typeof op !== 'string' || !OPERATORS.has(op)) {
    return { kind: 'opaque', reason: `unsupported where() operator ${String(op)}` };
  }
  return { kind: 'binary', column: unqualify(column), op: op as MockDbOperator, value };
}

/** Compare two scalars for `=` / `in`, with Date compared by instant. */
function scalarEquals(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Date && typeof b === 'string') return a.toISOString() === b;
  if (b instanceof Date && typeof a === 'string') return b.toISOString() === a;
  return a === b;
}

/** Order two scalars for `<` / `<=` / `>` / `>=`; `undefined` if incomparable. */
function compareScalars(a: unknown, b: unknown): number | undefined {
  const na = a instanceof Date ? a.getTime() : a;
  const nb = b instanceof Date ? b.getTime() : b;
  if (typeof na === 'number' && typeof nb === 'number') return na - nb;
  if (typeof na === 'bigint' && typeof nb === 'bigint') return na < nb ? -1 : na > nb ? 1 : 0;
  if (typeof na === 'string' && typeof nb === 'string') return na < nb ? -1 : na > nb ? 1 : 0;
  return undefined;
}

/** Translate a SQL LIKE pattern into an anchored regular expression. */
function likeToRegExp(pattern: string, caseInsensitive: boolean): RegExp {
  let out = '';
  for (const ch of pattern) {
    if (ch === '%') out += '[\\s\\S]*';
    else if (ch === '_') out += '[\\s\\S]';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, caseInsensitive ? 'i' : '');
}

/**
 * Evaluate one binary predicate against a row.
 *
 * Returns `undefined` when the predicate cannot be decided — the row does not
 * declare the column, or the values are not comparable. An undecided predicate
 * does not exclude the row (see the module docblock).
 */
export function evaluatePredicate(
  row: Record<string, unknown>,
  predicate: BinaryPredicate,
): boolean | undefined {
  const { column, op, value } = predicate;
  const isNullCheck = op === MockDbOperator.is || op === MockDbOperator.isNot;
  if (!(column in row) && !isNullCheck) return undefined;
  const actual = row[column];

  switch (op) {
    case MockDbOperator.eq:
      return scalarEquals(actual, value);
    case MockDbOperator.neq:
    case MockDbOperator.neqAnsi:
      return !scalarEquals(actual, value);
    case MockDbOperator.in:
    case MockDbOperator.notIn: {
      if (!Array.isArray(value)) return undefined;
      const hit = value.some((v) => scalarEquals(actual, v));
      return op === MockDbOperator.in ? hit : !hit;
    }
    case MockDbOperator.is:
    case MockDbOperator.isNot: {
      // `is null` on a column the fixture omits is decidable: an absent key and
      // an explicit null model the same thing on the read side.
      const hit = value === null ? actual === null || actual === undefined : actual === value;
      return op === MockDbOperator.is ? hit : !hit;
    }
    case MockDbOperator.like:
    case MockDbOperator.notLike:
    case MockDbOperator.ilike:
    case MockDbOperator.notILike: {
      if (typeof actual !== 'string' || typeof value !== 'string') return undefined;
      const ci = op === MockDbOperator.ilike || op === MockDbOperator.notILike;
      const hit = likeToRegExp(value, ci).test(actual);
      const negated = op === MockDbOperator.notLike || op === MockDbOperator.notILike;
      return negated ? !hit : hit;
    }
    default: {
      const ord = compareScalars(actual, value);
      if (ord === undefined) return undefined;
      if (op === MockDbOperator.lt) return ord < 0;
      if (op === MockDbOperator.lte) return ord <= 0;
      if (op === MockDbOperator.gt) return ord > 0;
      return ord >= 0;
    }
  }
}

/** True when the row satisfies every predicate the mock could decide. */
export function rowMatches(row: unknown, predicates: readonly MockDbPredicate[]): boolean {
  if (row === null || typeof row !== 'object') return true;
  const record = row as Record<string, unknown>;
  for (const predicate of predicates) {
    if (predicate.kind !== 'binary') continue;
    if (evaluatePredicate(record, predicate) === false) return false;
  }
  return true;
}

/** Keep only the rows satisfying every decidable predicate. */
export function filterRows<T>(rows: readonly T[], predicates: readonly MockDbPredicate[]): T[] {
  return rows.filter((row) => rowMatches(row, predicates));
}

/** One projected column: the row key read, and the key it is emitted under. */
export interface ProjectedColumn {
  source: string;
  alias: string;
}

/**
 * Parse `.select(...)` arguments into a projection.
 *
 * Returns `undefined` when the projection cannot be modelled — an aggregate
 * expression, an `eb` callback, a raw `sql` fragment. An unmodelled projection
 * leaves rows untouched rather than guessing at their shape.
 */
export function parseSelectArgs(args: readonly unknown[]): ProjectedColumn[] | undefined {
  const flat = args.length === 1 && Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
  if (flat.length === 0) return undefined;
  const columns: ProjectedColumn[] = [];
  for (const entry of flat) {
    if (typeof entry !== 'string') return undefined;
    const aliased = /^(.*?)\s+as\s+(.+)$/i.exec(entry.trim());
    if (aliased) {
      columns.push({ source: unqualify(aliased[1].trim()), alias: aliased[2].trim() });
    } else {
      const bare = unqualify(entry.trim());
      columns.push({ source: bare, alias: bare });
    }
  }
  return columns;
}

/**
 * Narrow a row to the projected columns.
 *
 * A projected column the fixture row does not declare is omitted rather than
 * emitted as `undefined`, so `'key' in row` keeps meaning "the fixture modelled
 * this" — the same convention {@link evaluatePredicate} reads.
 *
 * A column is read under its `source` name and, failing that, under its
 * `alias`. Fixtures in this repo are written both ways — some model the raw
 * table row (`storage_key`), others the row the aliased query returns
 * (`storageKey`) — and the projection has to narrow both. Reading either name
 * costs nothing: a column dropped from the projection disappears from the
 * output under both conventions, which is the regression this exists to catch.
 */
export function projectRow<T>(row: T, columns: readonly ProjectedColumn[]): T {
  if (row === null || typeof row !== 'object') return row;
  const record = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const { source, alias } of columns) {
    if (source in record) out[alias] = record[source];
    else if (alias in record) out[alias] = record[alias];
  }
  return out as T;
}

/** Narrow every row to the projected columns. */
export function projectRows<T>(rows: readonly T[], columns: readonly ProjectedColumn[]): T[] {
  return rows.map((row) => projectRow(row, columns));
}

/**
 * Describe the predicates the mock recorded but could not evaluate.
 *
 * Exposed so a test that cares whether its filter was actually pinned can
 * assert the mock understood it, instead of assuming it did.
 */
export function explainSkippedPredicates(predicates: readonly MockDbPredicate[]): string[] {
  return predicates.filter((p) => p.kind === 'opaque').map((p) => p.reason);
}
