import { describe, it, expect } from 'vitest';
import { workflow } from './workflow.js';
import { job } from './job.js';
import { step } from './step.js';
import type { FilterContext } from './filter.js';

const noop = job('noop', { runsOn: 'linux', steps: [step('x', { run: async () => {} })] });

describe('workflow filter', () => {
  it('carries the filter function through to the workflow object', () => {
    const filter = async ({ sourceRepo }: FilterContext) => sourceRepo.identifier !== 'a/b';
    const wf = workflow('org-ci', { jobs: [noop], filter });
    expect(wf.filter).toBe(filter);
  });

  it('leaves filter undefined when not declared', () => {
    expect(workflow('org-ci', { jobs: [noop] }).filter).toBeUndefined();
  });

  it('rejects a non-function filter', () => {
    expect(() =>
      // @ts-expect-error deliberately wrong type -- the runtime guard is what is under test
      workflow('org-ci', { jobs: [noop], filter: 'yes' }),
    ).toThrow(/filter must be a function/);
  });

  it('accepts a synchronous filter', () => {
    const filter = ({ workflowRepo }: FilterContext) => workflowRepo.identifier === 'org/ci';
    expect(workflow('org-ci', { jobs: [noop], filter }).filter).toBe(filter);
  });
});
