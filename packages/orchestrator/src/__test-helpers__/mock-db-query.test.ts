import { describe, expect, it } from 'vitest';
import {
  type BinaryPredicate,
  MockDbOperator,
  evaluatePredicate,
  explainSkippedPredicates,
  filterRows,
  parseSelectArgs,
  parseWhereArgs,
  projectRow,
  projectRows,
  rowMatches,
  unqualify,
} from './mock-db-query.js';

/**
 * Shorthand for the 3-arg binary shape the mock evaluates.
 *
 * Throws rather than narrowing with a cast: a case that silently parsed opaque
 * would then be asserted as passing every predicate, which is the failure mode
 * these tests exist to detect.
 */
function where(column: string, op: MockDbOperator, value: unknown): BinaryPredicate {
  const parsed = parseWhereArgs([column, op, value]);
  if (parsed.kind !== 'binary') {
    throw new Error(`expected a binary predicate for ${column} ${op}, got: ${parsed.reason}`);
  }
  return parsed;
}

describe('unqualify', () => {
  it('strips a table qualifier', () => {
    expect(unqualify('execution_runs.id')).toBe('id');
  });

  it('strips surrounding quotes left by a qualified identifier', () => {
    expect(unqualify('"execution_runs"."id"')).toBe('id');
  });

  it('leaves a bare column alone', () => {
    expect(unqualify('id')).toBe('id');
  });
});

describe('parseWhereArgs', () => {
  it('parses the binary shape', () => {
    expect(parseWhereArgs(['runs.status', '=', 'pending'])).toEqual({
      kind: 'binary',
      column: 'status',
      op: MockDbOperator.eq,
      value: 'pending',
    });
  });

  it('marks an expression-builder callback opaque', () => {
    const parsed = parseWhereArgs([() => undefined]);
    expect(parsed.kind).toBe('opaque');
  });

  it('marks an unrecognized operator opaque rather than guessing', () => {
    const parsed = parseWhereArgs(['col', '@>', 'x']);
    expect(parsed).toEqual({ kind: 'opaque', reason: 'unsupported where() operator @>' });
  });

  it('marks a non-string column opaque', () => {
    const parsed = parseWhereArgs([{ raw: true }, '=', 1]);
    expect(parsed.kind).toBe('opaque');
  });
});

describe('evaluatePredicate', () => {
  it('decides equality', () => {
    expect(
      evaluatePredicate({ status: 'pending' }, where('status', MockDbOperator.eq, 'pending')),
    ).toBe(true);
    expect(
      evaluatePredicate({ status: 'done' }, where('status', MockDbOperator.eq, 'pending')),
    ).toBe(false);
  });

  it('decides inequality in both spellings', () => {
    expect(evaluatePredicate({ n: 1 }, where('n', MockDbOperator.neq, 1))).toBe(false);
    expect(evaluatePredicate({ n: 1 }, where('n', MockDbOperator.neqAnsi, 2))).toBe(true);
  });

  it('decides in / not in', () => {
    expect(evaluatePredicate({ s: 'a' }, where('s', MockDbOperator.in, ['a', 'b']))).toBe(true);
    expect(evaluatePredicate({ s: 'c' }, where('s', MockDbOperator.in, ['a', 'b']))).toBe(false);
    expect(evaluatePredicate({ s: 'c' }, where('s', MockDbOperator.notIn, ['a', 'b']))).toBe(true);
  });

  it('leaves in / not in undecided when the bound value is not an array', () => {
    expect(evaluatePredicate({ s: 'a' }, where('s', MockDbOperator.in, 'a'))).toBeUndefined();
  });

  it('decides is null against an explicit null and an absent key alike', () => {
    expect(evaluatePredicate({ x: null }, where('x', MockDbOperator.is, null))).toBe(true);
    expect(evaluatePredicate({}, where('x', MockDbOperator.is, null))).toBe(true);
    expect(evaluatePredicate({ x: 1 }, where('x', MockDbOperator.is, null))).toBe(false);
    expect(evaluatePredicate({ x: 1 }, where('x', MockDbOperator.isNot, null))).toBe(true);
  });

  it('orders numbers, bigints, strings and dates', () => {
    expect(evaluatePredicate({ n: 5 }, where('n', MockDbOperator.lt, 10))).toBe(true);
    expect(evaluatePredicate({ n: 5 }, where('n', MockDbOperator.gte, 5))).toBe(true);
    expect(evaluatePredicate({ n: 5n }, where('n', MockDbOperator.gt, 6n))).toBe(false);
    expect(evaluatePredicate({ s: 'b' }, where('s', MockDbOperator.lte, 'a'))).toBe(false);
    const early = new Date('2020-01-01T00:00:00Z');
    const late = new Date('2021-01-01T00:00:00Z');
    expect(evaluatePredicate({ at: early }, where('at', MockDbOperator.lt, late))).toBe(true);
  });

  it('treats a Date and its ISO string as equal', () => {
    const at = new Date('2020-01-01T00:00:00.000Z');
    expect(evaluatePredicate({ at }, where('at', MockDbOperator.eq, at.toISOString()))).toBe(true);
  });

  it('leaves an incomparable ordering undecided', () => {
    expect(evaluatePredicate({ n: 'x' }, where('n', MockDbOperator.lt, 10))).toBeUndefined();
  });

  it('decides like / ilike with % and _ wildcards', () => {
    expect(evaluatePredicate({ k: 'kici/a/b' }, where('k', MockDbOperator.like, 'kici/%'))).toBe(
      true,
    );
    expect(evaluatePredicate({ k: 'other/a' }, where('k', MockDbOperator.like, 'kici/%'))).toBe(
      false,
    );
    expect(evaluatePredicate({ k: 'abc' }, where('k', MockDbOperator.like, 'a_c'))).toBe(true);
    expect(evaluatePredicate({ k: 'abbc' }, where('k', MockDbOperator.like, 'a_c'))).toBe(false);
    expect(evaluatePredicate({ k: 'KICI/a' }, where('k', MockDbOperator.ilike, 'kici/%'))).toBe(
      true,
    );
    expect(evaluatePredicate({ k: 'KICI/a' }, where('k', MockDbOperator.like, 'kici/%'))).toBe(
      false,
    );
    expect(evaluatePredicate({ k: 'other' }, where('k', MockDbOperator.notLike, 'kici/%'))).toBe(
      true,
    );
  });

  it('does not let a LIKE pattern smuggle in regex metacharacters', () => {
    expect(evaluatePredicate({ k: 'axc' }, where('k', MockDbOperator.like, 'a.c'))).toBe(false);
    expect(evaluatePredicate({ k: 'a.c' }, where('k', MockDbOperator.like, 'a.c'))).toBe(true);
  });

  it('leaves a predicate on an undeclared column undecided', () => {
    expect(
      evaluatePredicate({ id: 'a' }, where('status', MockDbOperator.eq, 'pending')),
    ).toBeUndefined();
  });
});

describe('rowMatches / filterRows', () => {
  const pending = { id: 'a', status: 'pending' };
  const done = { id: 'b', status: 'done' };

  it('excludes a row that contradicts a decidable predicate', () => {
    expect(rowMatches(done, [where('status', MockDbOperator.eq, 'pending')])).toBe(false);
    expect(filterRows([pending, done], [where('status', MockDbOperator.eq, 'pending')])).toEqual([
      pending,
    ]);
  });

  it('applies every predicate conjunctively', () => {
    const predicates = [
      where('status', MockDbOperator.eq, 'pending'),
      where('id', MockDbOperator.eq, 'zzz'),
    ];
    expect(filterRows([pending, done], predicates)).toEqual([]);
  });

  it('ignores an opaque predicate instead of excluding everything', () => {
    const opaque = parseWhereArgs([() => undefined]);
    expect(filterRows([pending, done], [opaque])).toEqual([pending, done]);
  });

  it('passes a row through predicates it does not declare', () => {
    expect(filterRows([{ id: 'a' }], [where('status', MockDbOperator.eq, 'pending')])).toEqual([
      { id: 'a' },
    ]);
  });

  it('leaves non-object rows alone', () => {
    expect(rowMatches('scalar', [where('status', MockDbOperator.eq, 'pending')])).toBe(true);
    expect(rowMatches(null, [where('status', MockDbOperator.eq, 'pending')])).toBe(true);
  });
});

describe('parseSelectArgs', () => {
  it('parses an array of plain columns', () => {
    expect(parseSelectArgs([['id', 'status']])).toEqual([
      { source: 'id', alias: 'id' },
      { source: 'status', alias: 'status' },
    ]);
  });

  it('parses varargs columns', () => {
    expect(parseSelectArgs(['id', 'status'])).toEqual([
      { source: 'id', alias: 'id' },
      { source: 'status', alias: 'status' },
    ]);
  });

  it('strips table qualifiers and honours aliases', () => {
    expect(parseSelectArgs([['runs.id as run_id', 'jobs.status']])).toEqual([
      { source: 'id', alias: 'run_id' },
      { source: 'status', alias: 'status' },
    ]);
  });

  it('returns undefined for a projection it cannot model', () => {
    expect(parseSelectArgs([[{ aggregate: true }]])).toBeUndefined();
    expect(parseSelectArgs([() => undefined])).toBeUndefined();
    expect(parseSelectArgs([])).toBeUndefined();
    expect(parseSelectArgs([[]])).toBeUndefined();
  });
});

describe('projectRow / projectRows', () => {
  it('drops columns the projection does not name', () => {
    expect(
      projectRow({ id: 'a', status: 'pending', secret: 'x' }, [{ source: 'id', alias: 'id' }]),
    ).toEqual({
      id: 'a',
    });
  });

  it('renames an aliased column', () => {
    expect(projectRow({ id: 'a' }, [{ source: 'id', alias: 'run_id' }])).toEqual({ run_id: 'a' });
  });

  it('reads a column under its alias when the row is already in output shape', () => {
    expect(
      projectRow({ storageKey: 'k' }, [{ source: 'storage_key', alias: 'storageKey' }]),
    ).toEqual({ storageKey: 'k' });
  });

  it('prefers the source name when the row declares both', () => {
    expect(
      projectRow({ storage_key: 'raw', storageKey: 'aliased' }, [
        { source: 'storage_key', alias: 'storageKey' },
      ]),
    ).toEqual({ storageKey: 'raw' });
  });

  it('omits a projected column the row does not declare under either name', () => {
    expect(projectRow({ id: 'a' }, [{ source: 'missing', alias: 'missing' }])).toEqual({});
    expect(projectRow({ id: 'a' }, [{ source: 'src', alias: 'ali' }])).toEqual({});
  });

  it('leaves non-object rows alone', () => {
    expect(projectRow(7, [{ source: 'id', alias: 'id' }])).toBe(7);
  });

  it('projects every row', () => {
    expect(
      projectRows(
        [
          { id: 'a', x: 1 },
          { id: 'b', x: 2 },
        ],
        [{ source: 'id', alias: 'id' }],
      ),
    ).toEqual([{ id: 'a' }, { id: 'b' }]);
  });
});

describe('explainSkippedPredicates', () => {
  it('names only the predicates the mock could not read', () => {
    const predicates = [where('id', MockDbOperator.eq, 'a'), parseWhereArgs([() => undefined])];
    expect(explainSkippedPredicates(predicates)).toEqual(['where() with 1 argument(s)']);
  });
});
