import { describe, it, expect } from 'vitest';
import {
  cartesianProduct,
  expandSingleDimension,
  expandMultiDimension,
  expandMatrix,
  applyIncludeExclude,
  normalizeMatrixInput,
  matrixCombinationCount,
  findDuplicateCombination,
  MatrixShapeError,
  type MatrixValues,
} from './expand.js';
import { formatExpandedJobName } from './format.js';

describe('cartesianProduct', () => {
  it('returns a single empty tuple for an empty input', () => {
    expect(cartesianProduct([])).toEqual([[]]);
  });

  it('returns one tuple per value for a single dimension', () => {
    expect(cartesianProduct([['a', 'b', 'c']])).toEqual([['a'], ['b'], ['c']]);
  });

  it('computes the product of two dimensions in row-major order', () => {
    expect(
      cartesianProduct([
        ['a', 'b'],
        ['1', '2'],
      ]),
    ).toEqual([
      ['a', '1'],
      ['a', '2'],
      ['b', '1'],
      ['b', '2'],
    ]);
  });

  it('computes the product of three dimensions with correct cardinality', () => {
    const result = cartesianProduct([
      ['a', 'b'],
      ['1', '2'],
      ['x', 'y'],
    ]);
    expect(result).toHaveLength(8);
    expect(result[0]).toEqual(['a', '1', 'x']);
    expect(result[7]).toEqual(['b', '2', 'y']);
  });

  it('yields no tuples when any dimension is empty', () => {
    expect(cartesianProduct([['a', 'b'], []])).toEqual([]);
  });
});

describe('expandSingleDimension', () => {
  it('should expand array to single-dimension MatrixValues', () => {
    const matrix = ['linux', 'mac', 'windows'];
    const result = expandSingleDimension(matrix);

    expect(result).toEqual([{ value: 'linux' }, { value: 'mac' }, { value: 'windows' }]);
  });

  it('should handle single value array', () => {
    const matrix = ['prod'];
    const result = expandSingleDimension(matrix);

    expect(result).toEqual([{ value: 'prod' }]);
  });

  it('should preserve order of input array', () => {
    const matrix = ['z', 'a', 'm'];
    const result = expandSingleDimension(matrix);

    expect(result).toEqual([{ value: 'z' }, { value: 'a' }, { value: 'm' }]);
  });

  it('should handle values with special characters', () => {
    const matrix = ['prod-us', 'staging-eu'];
    const result = expandSingleDimension(matrix);

    expect(result).toEqual([{ value: 'prod-us' }, { value: 'staging-eu' }]);
  });
});

describe('expandMultiDimension', () => {
  it('should produce cartesian product of two dimensions', () => {
    const matrix = {
      os: ['linux', 'mac'],
      node: ['18', '20'],
    };
    const result = expandMultiDimension(matrix);

    expect(result).toHaveLength(4);
    expect(result).toEqual(
      expect.arrayContaining([
        { node: '18', os: 'linux' },
        { node: '18', os: 'mac' },
        { node: '20', os: 'linux' },
        { node: '20', os: 'mac' },
      ]),
    );
  });

  it('should produce cartesian product of three dimensions', () => {
    const matrix = {
      a: ['1', '2'],
      b: ['x', 'y'],
      c: ['!', '@'],
    };
    const result = expandMultiDimension(matrix);

    expect(result).toHaveLength(8);
    // Verify some specific combinations
    expect(result).toEqual(
      expect.arrayContaining([
        { a: '1', b: 'x', c: '!' },
        { a: '2', b: 'y', c: '@' },
      ]),
    );
  });

  it('should produce deterministic output (sorted dimension names)', () => {
    const matrix = {
      z: ['1'],
      a: ['2'],
      m: ['3'],
    };
    const result = expandMultiDimension(matrix);

    // With sorted keys: a, m, z
    expect(result).toEqual([{ a: '2', m: '3', z: '1' }]);
  });

  it('keeps a dimension literally named __proto__', () => {
    // Building each combination by assignment would run the inherited
    // `__proto__` setter and silently drop the dimension.
    const matrix = JSON.parse('{"__proto__":["p"],"os":["linux"]}') as Record<string, string[]>;
    const result = expandMultiDimension(matrix);

    expect(result).toHaveLength(1);
    expect(Object.keys(result[0])).toEqual(['__proto__', 'os']);
  });

  it('should handle empty object defensively', () => {
    const matrix = {};
    const result = expandMultiDimension(matrix);

    expect(result).toEqual([]);
  });

  it('should handle single dimension object', () => {
    const matrix = {
      env: ['dev', 'prod'],
    };
    const result = expandMultiDimension(matrix);

    expect(result).toEqual([{ env: 'dev' }, { env: 'prod' }]);
  });
});

describe('expandMatrix', () => {
  it('should dispatch to expandSingleDimension for arrays', () => {
    const matrix = ['a', 'b', 'c'];
    const result = expandMatrix(matrix);

    expect(result).toEqual([{ value: 'a' }, { value: 'b' }, { value: 'c' }]);
  });

  it('should dispatch to expandMultiDimension for objects', () => {
    const matrix = {
      x: ['1', '2'],
      y: ['a', 'b'],
    };
    const result = expandMatrix(matrix);

    expect(result).toHaveLength(4);
    expect(result).toEqual(
      expect.arrayContaining([
        { x: '1', y: 'a' },
        { x: '1', y: 'b' },
        { x: '2', y: 'a' },
        { x: '2', y: 'b' },
      ]),
    );
  });
});

describe('normalizeMatrixInput', () => {
  it('normalizes an array form', () => {
    expect(normalizeMatrixInput(['a', 'b'])).toEqual({ kind: 'array', values: ['a', 'b'] });
  });

  it('normalizes an object form with sorted dimensions', () => {
    expect(normalizeMatrixInput({ y: ['1'], x: ['a'] })).toEqual({
      kind: 'object',
      dimensions: [
        ['x', ['a']],
        ['y', ['1']],
      ],
    });
  });

  it('coerces numeric and boolean elements to strings', () => {
    expect(normalizeMatrixInput([18, 20, true])).toEqual({
      kind: 'array',
      values: ['18', '20', 'true'],
    });
  });

  for (const [label, input] of [
    ['undefined', undefined],
    ['null', null],
    ['a number', 7],
  ] as const) {
    it(`rejects ${label}`, () => {
      expect(() => normalizeMatrixInput(input)).toThrow(MatrixShapeError);
    });
  }

  it('names the documented contract in the message', () => {
    expect(() => normalizeMatrixInput(undefined)).toThrow(
      /matrix must be a string array or an object of string arrays/,
    );
  });

  it('rejects a bare string and explains the per-character trap', () => {
    expect(() => normalizeMatrixInput('linux')).toThrow(/one dimension per character/);
  });

  it('rejects a dimension whose value is not an array, naming the dimension', () => {
    expect(() => normalizeMatrixInput({ os: 'linux' })).toThrow(/dimension "os"/);
  });

  for (const [label, element] of [
    ['an object', { a: 1 }],
    ['an array', []],
    ['null', null],
  ] as const) {
    it(`rejects ${label} as an element`, () => {
      expect(() => normalizeMatrixInput([element])).toThrow(MatrixShapeError);
    });
  }
});

describe('expandMatrix input-shape regressions', () => {
  // The two symptoms the guard exists for. They must fail loudly forever.
  it('does not throw a bare TypeError when the matrix function forgot its return', () => {
    expect(() => expandMatrix(undefined)).toThrow(MatrixShapeError);
    expect(() => expandMatrix(undefined)).not.toThrow(TypeError);
  });

  it('does not read a bare string as one dimension per character', () => {
    expect(() => expandMatrix('linux')).toThrow(MatrixShapeError);
  });

  it('does not silently expand a non-string element into an [object Object] job name', () => {
    expect(() => expandMatrix([{ a: 1 }])).toThrow(MatrixShapeError);
  });

  it('rejects a hole in a sparse array rather than letting it through', () => {
    // `.map` skips holes; `Array.from` visits them as undefined, so the element
    // check actually runs. Without it a hole reaches MatrixValues as undefined.
    expect(() => expandMatrix([, 'a'])).toThrow(MatrixShapeError);
  });

  it('names the offending element index', () => {
    expect(() => expandMatrix(['a', { b: 1 }])).toThrow(/values\[1\]/);
    expect(() => expandMatrix({ os: ['linux', null] })).toThrow(/dimension "os"\[1\]/);
  });

  it('collapses an empty dimension without materializing the other dimensions', () => {
    // 1000^3 x 0. The combination count is 0, so no size guard fires — the
    // empty-set short-circuit is the only thing standing between this and 1e9
    // intermediate tuples. Without it this OOMs rather than returning [].
    const big = Array.from({ length: 1000 }, (_, i) => `v${i}`);
    expect(expandMatrix({ a: big, b: big, c: big, z: [] })).toEqual([]);
  });
});

describe('matrixCombinationCount', () => {
  it('counts an array form as its length', () => {
    expect(matrixCombinationCount(['a', 'b', 'c'])).toBe(3);
  });

  it('counts an object form as the product of its dimensions', () => {
    expect(matrixCombinationCount({ os: ['a', 'b'], node: ['1', '2', '3'] })).toBe(6);
  });

  it('counts an empty object as zero combinations', () => {
    expect(matrixCombinationCount({})).toBe(0);
  });

  it('validates its own input rather than assuming expandMatrix ran first', () => {
    expect(() => matrixCombinationCount('linux')).toThrow(MatrixShapeError);
  });

  it('counts an empty dimension as zero combinations', () => {
    expect(matrixCombinationCount({ a: ['x', 'y'], z: [] })).toBe(0);
  });

  it('counts without materializing the product', () => {
    // 1000^3 = 1e9 combinations. If this materialized, the test would OOM.
    const big = Array.from({ length: 1000 }, (_, i) => `v${i}`);
    expect(matrixCombinationCount({ a: big, b: big, c: big })).toBe(1_000_000_000);
  });
});

describe('findDuplicateCombination', () => {
  it('returns null for distinct combinations', () => {
    expect(findDuplicateCombination([{ value: 'a' }, { value: 'b' }])).toBeNull();
  });

  it('finds a repeated single-dimension value', () => {
    expect(findDuplicateCombination([{ value: 'linux' }, { value: 'linux' }])).toEqual({
      value: 'linux',
    });
  });

  it('finds a repeated multi-dimension combination regardless of key order', () => {
    expect(
      findDuplicateCombination([
        { os: 'linux', node: '18' },
        { node: '18', os: 'linux' },
      ]),
    ).toEqual({ node: '18', os: 'linux' });
  });

  it('does not treat different combinations as duplicates', () => {
    expect(
      findDuplicateCombination([
        { os: 'linux', node: '18' },
        { os: 'linux', node: '20' },
      ]),
    ).toBeNull();
  });

  it('catches a name collision between structurally different combinations', () => {
    // Distinct combinations, identical rendered name — the collision that
    // actually hurts. The structural default misses it; a name key catches it.
    const combos: MatrixValues[] = [{ value: 'a' }, { other: 'a' }];
    expect(findDuplicateCombination(combos)).toBeNull();
    expect(findDuplicateCombination(combos, (c) => formatExpandedJobName('job', c))).toEqual({
      other: 'a',
    });
  });
});

describe('applyIncludeExclude', () => {
  it('should remove matching combinations with exclude', () => {
    const expanded: MatrixValues[] = [
      { os: 'linux', node: '18' },
      { os: 'linux', node: '20' },
      { os: 'mac', node: '18' },
      { os: 'mac', node: '20' },
    ];
    const exclude = [{ os: 'mac', node: '18' }];
    const result = applyIncludeExclude(expanded, undefined, exclude);

    expect(result).toHaveLength(3);
    expect(result).not.toContainEqual({ os: 'mac', node: '18' });
    expect(result).toEqual(
      expect.arrayContaining([
        { os: 'linux', node: '18' },
        { os: 'linux', node: '20' },
        { os: 'mac', node: '20' },
      ]),
    );
  });

  it('should handle partial exclude match (removes all matching dimension)', () => {
    const expanded: MatrixValues[] = [
      { os: 'linux', node: '18' },
      { os: 'linux', node: '20' },
      { os: 'mac', node: '18' },
      { os: 'mac', node: '20' },
    ];
    const exclude = [{ os: 'mac' }];
    const result = applyIncludeExclude(expanded, undefined, exclude);

    expect(result).toHaveLength(2);
    expect(result).toEqual(
      expect.arrayContaining([
        { os: 'linux', node: '18' },
        { os: 'linux', node: '20' },
      ]),
    );
  });

  it('should add new combinations with include', () => {
    const expanded: MatrixValues[] = [
      { os: 'linux', node: '18' },
      { os: 'linux', node: '20' },
    ];
    const include = [{ os: 'windows', node: '22' }];
    const result = applyIncludeExclude(expanded, include, undefined);

    expect(result).toHaveLength(3);
    expect(result).toContainEqual({ os: 'windows', node: '22' });
  });

  it('should not duplicate existing combinations with include', () => {
    const expanded: MatrixValues[] = [
      { os: 'linux', node: '18' },
      { os: 'linux', node: '20' },
    ];
    const include = [{ os: 'linux', node: '18' }];
    const result = applyIncludeExclude(expanded, include, undefined);

    expect(result).toHaveLength(2);
    expect(result.filter((c) => c.os === 'linux' && c.node === '18')).toHaveLength(1);
  });

  it('should apply exclude first, then include', () => {
    const expanded: MatrixValues[] = [
      { os: 'linux', node: '18' },
      { os: 'linux', node: '20' },
      { os: 'mac', node: '18' },
    ];
    const exclude = [{ os: 'mac', node: '18' }];
    const include = [{ os: 'mac', node: '18' }];
    const result = applyIncludeExclude(expanded, include, exclude);

    // Exclude removes mac/18, then include adds it back
    expect(result).toHaveLength(3);
    expect(result).toContainEqual({ os: 'mac', node: '18' });
  });

  it('should handle empty include array', () => {
    const expanded: MatrixValues[] = [{ value: 'a' }, { value: 'b' }];
    const result = applyIncludeExclude(expanded, [], undefined);

    expect(result).toEqual(expanded);
  });

  it('should handle empty exclude array', () => {
    const expanded: MatrixValues[] = [{ value: 'a' }, { value: 'b' }];
    const result = applyIncludeExclude(expanded, undefined, []);

    expect(result).toEqual(expanded);
  });

  it('should handle undefined include and exclude', () => {
    const expanded: MatrixValues[] = [{ value: 'a' }, { value: 'b' }];
    const result = applyIncludeExclude(expanded, undefined, undefined);

    expect(result).toEqual(expanded);
  });

  it('should treat empty exclude entry as matching nothing (not everything)', () => {
    // Regression: an empty exclude object `{}` used to match EVERY combination
    // because `[].every()` is vacuously true, silently wiping the entire matrix.
    // This can happen when a conditional spread collapses to `{}`:
    //   exclude: [{ ...(cond ? { os: 'mac' } : {}) }]
    const expanded: MatrixValues[] = [
      { os: 'linux', node: '18' },
      { os: 'linux', node: '20' },
      { os: 'mac', node: '18' },
    ];
    const result = applyIncludeExclude(expanded, undefined, [{}]);
    expect(result).toEqual(expanded);
  });

  it('should ignore empty include entries', () => {
    // An empty include `{}` would otherwise push a shape-less entry into the matrix.
    const expanded: MatrixValues[] = [
      { os: 'linux', node: '18' },
      { os: 'mac', node: '18' },
    ];
    const result = applyIncludeExclude(expanded, [{}], undefined);
    expect(result).toEqual(expanded);
  });

  it('sorts an include entry so it renders the same dimension order as its siblings', () => {
    // `expandMultiDimension` sorts dimension names, but an include entry keeps
    // the author's key order, and `formatMatrixSuffix` renders insertion order —
    // so an include child used to print its dimensions back-to-front relative to
    // every expanded sibling.
    const expanded = expandMatrix({ os: ['linux'], node: ['18'] });
    const result = applyIncludeExclude(expanded, [{ os: 'linux', node: '23' }], undefined);

    expect(Object.keys(result.at(-1)!)).toEqual(['node', 'os']);
    expect(result.map((c) => formatExpandedJobName('test', c))).toEqual([
      'test (18, linux)',
      'test (23, linux)',
    ]);
  });

  it('copies an include entry rather than aliasing the object it was given', () => {
    // The pushed combination becomes a child job's `variantValues`; aliasing it
    // would hand out a live reference to the lock job's own include entry.
    const incl = { os: 'linux', node: '23' };
    const result = applyIncludeExclude([], [incl], undefined);

    expect(result[0]).not.toBe(incl);
    expect(result[0]).toEqual({ node: '23', os: 'linux' });
  });

  it('keeps a dimension literally named __proto__ on an include entry', () => {
    // `sorted['__proto__'] = v` runs the inherited setter instead of defining an
    // own property, so a key-sorted copy built by assignment would drop the
    // dimension. A lock file is JSON, and `JSON.parse` does create an own
    // `__proto__` property.
    const incl = JSON.parse('{"os":"linux","__proto__":"p"}') as Record<string, string>;
    const result = applyIncludeExclude([], [incl], undefined);

    expect(Object.keys(result[0])).toEqual(['__proto__', 'os']);
    expect(formatExpandedJobName('test', result[0])).toBe('test (p, linux)');
  });

  it('should still apply non-empty excludes when mixed with empty ones', () => {
    const expanded: MatrixValues[] = [
      { os: 'linux', node: '18' },
      { os: 'linux', node: '20' },
      { os: 'mac', node: '18' },
    ];
    const result = applyIncludeExclude(expanded, undefined, [{}, { os: 'mac' }]);
    expect(result).toHaveLength(2);
    expect(result).toEqual([
      { os: 'linux', node: '18' },
      { os: 'linux', node: '20' },
    ]);
  });
});

describe('Integration tests', () => {
  it('should expand, exclude, then include new combinations', () => {
    const matrix = {
      os: ['linux', 'mac'],
      node: ['18', '20'],
    };

    const expanded = expandMatrix(matrix);
    expect(expanded).toHaveLength(4);

    const exclude = [{ os: 'mac', node: '18' }];
    const include = [{ os: 'windows', node: '20' }];
    const final = applyIncludeExclude(expanded, include, exclude);

    expect(final).toHaveLength(4);
    expect(final).not.toContainEqual({ os: 'mac', node: '18' });
    expect(final).toContainEqual({ os: 'windows', node: '20' });
    expect(final).toEqual(
      expect.arrayContaining([
        { os: 'linux', node: '18' },
        { os: 'linux', node: '20' },
        { os: 'mac', node: '20' },
        { os: 'windows', node: '20' },
      ]),
    );
  });

  it('should handle complete single-dimension workflow', () => {
    const matrix = ['linux', 'mac', 'windows'];
    const expanded = expandMatrix(matrix);
    const exclude = [{ value: 'windows' }];
    const final = applyIncludeExclude(expanded, undefined, exclude);

    expect(final).toEqual([{ value: 'linux' }, { value: 'mac' }]);
  });
});
