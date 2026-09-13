import { describe, it, expect } from 'vitest';
import { createFilterContext } from './filter-context.js';
import { createRuleContext } from './rules/context.js';
import { ChangedFilesUnavailableError } from './rules/changed-files.js';

const repos = {
  sourceRepo: { identifier: 'o/src', path: '/w/source', ref: 'main', sha: 'aaa' },
  workflowRepo: { identifier: 'o/wf', path: '/w/workflow', ref: 'main', sha: 'bbb' },
};

describe('createFilterContext', () => {
  it('exposes the repo pair, event, env and shell', () => {
    const ctx = createFilterContext({
      ...repos,
      event: { type: 'push', targetBranch: 'main' },
      env: { NODE_ENV: 'test' },
    });

    expect(ctx.sourceRepo).toEqual(repos.sourceRepo);
    expect(ctx.workflowRepo).toEqual(repos.workflowRepo);
    expect(ctx.event).toEqual({ type: 'push', targetBranch: 'main' });
    expect(ctx.env).toEqual({ NODE_ENV: 'test' });
    expect(typeof ctx.$).toBe('function');
  });

  it('returns the diff when the status is fetched', () => {
    const ctx = createFilterContext({
      ...repos,
      event: { type: 'push' },
      changedFiles: ['src/a.ts', 'src/b.ts'],
      changedFilesStatus: 'fetched',
    });

    expect(ctx.changedFiles).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('THROWS rather than returning an empty diff when changedFiles is unavailable', () => {
    // The load-bearing property. A plain `{ changedFiles: [] }` object literal
    // satisfies the FilterContext type with no error, and would let a path gate
    // silently suppress the whole workflow — no run row, no artifact to inspect.
    const ctx = createFilterContext({
      ...repos,
      event: { type: 'schedule' },
      changedFilesStatus: 'unavailable',
    });

    expect(() => ctx.changedFiles).toThrow(ChangedFilesUnavailableError);
    expect(() => ctx.changedFiles).toThrow(/status: unavailable/);
    expect(() => ctx.changedFiles).toThrow(/event: schedule/);
    expect(ctx.changedFilesStatus).toBe('unavailable');
  });

  it('defaults changedFilesStatus to fetched so a caller passing a real list needs no status', () => {
    const ctx = createFilterContext({ ...repos, event: {}, changedFiles: ['x'] });
    expect(ctx.changedFilesStatus).toBe('fetched');
    expect(ctx.changedFiles).toEqual(['x']);
  });

  it('installs changedFiles as a getter, matching createRuleContext', () => {
    // Both contexts must share ONE accessor: a second construction site could
    // ship a plain property and violate the throw contract with no type error.
    const filterCtx = createFilterContext({
      ...repos,
      event: {},
      changedFilesStatus: 'unavailable',
    });
    const ruleCtx = createRuleContext({ event: {}, changedFilesStatus: 'unavailable' });

    for (const ctx of [filterCtx, ruleCtx]) {
      const descriptor = Object.getOwnPropertyDescriptor(ctx, 'changedFiles');
      expect(typeof descriptor?.get).toBe('function');
      expect(descriptor?.value).toBeUndefined();
      expect(descriptor?.enumerable).toBe(true);
    }
  });
});
