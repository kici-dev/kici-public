import { describe, it, expectTypeOf } from 'vitest';
import { workflow } from './workflow.js';
import { job } from './job.js';
import { step } from './step.js';
import type { FilterContext, FilterFn } from './filter.js';

const noop = job('noop', { runsOn: 'linux', steps: [step('x', { run: async () => {} })] });

// Type-level counterpart to the runtime `filter must be a function` guard in
// filter.test.ts. That file is excluded from the SDK tsconfig and from the
// typecheck runner (which is scoped to *.test-d.ts), so its @ts-expect-error is
// never evaluated. These assertions live here so the typecheck runner enforces
// them: the negative case fails the suite if `filter` ever stops rejecting a
// non-function value.
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
