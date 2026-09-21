import { describe, it, expect } from 'vitest';
import * as shim from './expand.js';
import * as matrixBarrel from './index.js';
import * as internal from '../internal.js';

// The shim re-exports the matrix expansion engine. Its runtime surface must
// stay exactly the two symbols the SDK's internal entrypoint forwards — a
// re-export no entrypoint reaches is dead weight that still ships in the
// package. (Runtime only: a type-only re-export is invisible to Object.keys.)
describe('matrix expand shim', () => {
  it('exports exactly the symbols the SDK forwards on its internal entrypoint', () => {
    expect(Object.keys(shim).sort()).toEqual(['applyIncludeExclude', 'expandMatrix']);
  });

  it('backs the matrix barrel and the internal entrypoint with the same identities', () => {
    expect(matrixBarrel.expandMatrix).toBe(shim.expandMatrix);
    expect(matrixBarrel.applyIncludeExclude).toBe(shim.applyIncludeExclude);
    expect(internal.expandMatrix).toBe(shim.expandMatrix);
    expect(internal.applyIncludeExclude).toBe(shim.applyIncludeExclude);
  });

  it('forwards a working expandMatrix', () => {
    expect(shim.expandMatrix(['a', 'b'])).toEqual([{ value: 'a' }, { value: 'b' }]);
  });
});
