import { describe, it, expect } from 'vitest';
import { createRuleContext, ChangedFilesUnavailableError } from './context.js';

describe('createRuleContext', () => {
  it('returns the real list when status is fetched', () => {
    const ctx = createRuleContext({
      event: { type: 'push' },
      changedFiles: ['src/a.ts', 'README.md'],
      changedFilesStatus: 'fetched',
    });
    expect(ctx.changedFiles).toEqual(['src/a.ts', 'README.md']);
    expect(ctx.changedFilesStatus).toBe('fetched');
  });

  it('defaults status to fetched (compiler / test-harness callers)', () => {
    const ctx = createRuleContext({ event: { type: 'push' }, changedFiles: [] });
    expect(ctx.changedFilesStatus).toBe('fetched');
    expect(ctx.changedFiles).toEqual([]);
  });

  it('throws ChangedFilesUnavailableError when status is unavailable', () => {
    const ctx = createRuleContext({
      event: { type: 'schedule' },
      changedFilesStatus: 'unavailable',
    });
    expect(() => ctx.changedFiles).toThrow(ChangedFilesUnavailableError);
    try {
      void ctx.changedFiles;
    } catch (e) {
      expect(e).toBeInstanceOf(ChangedFilesUnavailableError);
      expect((e as ChangedFilesUnavailableError).changedFilesStatus).toBe('unavailable');
      expect((e as ChangedFilesUnavailableError).eventType).toBe('schedule');
    }
  });

  it('throws when status is skipped', () => {
    const ctx = createRuleContext({ event: { type: 'push' }, changedFilesStatus: 'skipped' });
    expect(() => ctx.changedFiles).toThrow(ChangedFilesUnavailableError);
  });

  it('carries env, dispatchInputs, fanout, and $', () => {
    const ctx = createRuleContext({
      event: { type: 'push' },
      env: { CI: 'true' },
      dispatchInputs: { flag: true },
      fanout: { index: 0, total: 2, first: true, last: false },
    });
    expect(ctx.env.CI).toBe('true');
    expect(ctx.dispatchInputs).toEqual({ flag: true });
    expect(ctx.fanout).toEqual({ index: 0, total: 2, first: true, last: false });
    expect(typeof ctx.$).toBe('function');
  });
});
