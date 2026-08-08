import { describe, it, expect } from 'vitest';
import * as shim from './expand.js';
import * as matrixBarrel from './index.js';
import * as sdk from '../index.js';

// The shim re-exports the matrix expansion engine. Its runtime surface must
// stay exactly the two symbols the SDK's public entrypoint forwards — a
// re-export no public path reaches is dead weight that still ships in the
// package. (Runtime only: a type-only re-export is invisible to Object.keys.)
describe('matrix expand shim', () => {
  it('exports exactly the symbols the SDK forwards publicly', () => {
    expect(Object.keys(shim).sort()).toEqual(['applyIncludeExclude', 'expandMatrix']);
  });

  it('backs the matrix barrel and the public entrypoint with the same identities', () => {
    expect(matrixBarrel.expandMatrix).toBe(shim.expandMatrix);
    expect(matrixBarrel.applyIncludeExclude).toBe(shim.applyIncludeExclude);
    expect(sdk.expandMatrix).toBe(shim.expandMatrix);
    expect(sdk.applyIncludeExclude).toBe(shim.applyIncludeExclude);
  });

  it('forwards a working expandMatrix', () => {
    expect(shim.expandMatrix(['a', 'b'])).toEqual([{ value: 'a' }, { value: 'b' }]);
  });
});
