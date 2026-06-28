import { describe, it, expect } from 'vitest';
import { flattenLockSteps } from './flatten-lock-steps.js';
import type { LockStepEntry } from '@kici-dev/engine';

describe('flattenLockSteps', () => {
  it('inlines parallel children in order, drops the group wrapper', () => {
    const flat = flattenLockSteps([
      { name: 'checkout', hasOutputs: false },
      {
        kind: 'parallel',
        name: 'g0',
        failFast: true,
        children: [
          { name: 'lint', hasOutputs: false, sourceLocation: { file: 'a.ts', line: 1, column: 1 } },
          { name: 'tc', hasOutputs: false, sourceLocation: { file: 'a.ts', line: 2, column: 1 } },
        ],
      },
      { name: 'deploy', hasOutputs: false },
    ] as LockStepEntry[]);
    expect(flat.map((s) => s.name)).toEqual(['checkout', 'lint', 'tc', 'deploy']);
    expect(flat[1].sourceLocation?.line).toBe(1); // index 1 = first parallel child
    expect(flat[2].sourceLocation?.line).toBe(2);
  });

  it('passes a flat sequential list through unchanged', () => {
    const steps: LockStepEntry[] = [
      { name: 'a', hasOutputs: false },
      { name: 'b', hasOutputs: false },
    ];
    expect(flattenLockSteps(steps).map((s) => s.name)).toEqual(['a', 'b']);
  });
});
