import { describe, it, expectTypeOf } from 'vitest';
import { workflow } from './workflow.js';
import { job } from './job.js';
import { step } from './step.js';
import type { FilterContext, FilterFn } from './filter.js';

const noop = job('noop', { runsOn: 'linux', steps: [step('x', { run: async () => {} })] });

// Type-level twin of filter.test.ts's `filter must be a function` guard. That
// file is outside the SDK tsconfig and the typecheck runner (*.test-d.ts only),
// so its @ts-expect-error is never evaluated; here the runner enforces it.
describe('workflow filter — type level', () => {
  it('rejects a non-function filter', () => {
    // @ts-expect-error — filter must be a FilterFn, not a string
    void workflow('org-ci', { jobs: [noop], filter: 'yes' });
  });

  it('accepts a function filter', () => {
    const filter = ({ sourceRepo }: FilterContext) => sourceRepo.identifier !== 'a/b';
    const wf = workflow('org-ci', { jobs: [noop], filter });
    expectTypeOf(wf.filter).toEqualTypeOf<FilterFn | undefined>();
  });
});
