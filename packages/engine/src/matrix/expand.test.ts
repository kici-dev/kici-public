import { describe, it, expect } from 'vitest';
import {
  cartesianProduct,
  expandSingleDimension,
  expandMultiDimension,
  expandMatrix,
  applyIncludeExclude,
  type MatrixValues,
} from './expand.js';

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
