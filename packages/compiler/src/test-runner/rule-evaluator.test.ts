import { describe, it, expect } from 'vitest';
import type { EventPayload } from '@kici-dev/sdk';
import { createRuleContext } from './rule-evaluator.js';

describe('compiler test-runner rule context', () => {
  it('defaults to fetched so changedFiles is readable', () => {
    const ctx = createRuleContext({
      event: { type: 'push' } as EventPayload,
      changedFiles: ['a.ts'],
    });
    expect(ctx.changedFiles).toEqual(['a.ts']);
    expect(ctx.changedFilesStatus).toBe('fetched');
  });

  it('exposes the developer process env to rules', () => {
    process.env.KICI_TEST_RULE_ENV = 'yes';
    const ctx = createRuleContext({ event: { type: 'push' } as EventPayload });
    expect(ctx.env.KICI_TEST_RULE_ENV).toBe('yes');
    delete process.env.KICI_TEST_RULE_ENV;
  });

  it('honors an explicit unavailable status', () => {
    const ctx = createRuleContext({
      event: { type: 'schedule' } as EventPayload,
      changedFilesStatus: 'unavailable',
    });
    expect(() => ctx.changedFiles).toThrow();
  });
});
