import { describe, it, expect } from 'vitest';
import { evaluateRules } from './evaluator.js';
import { createRuleContext, ChangedFilesUnavailableError } from './context.js';
import { rule } from './rule.js';

describe('evaluateRules — changedFiles availability', () => {
  it('re-throws ChangedFilesUnavailableError instead of folding it into passed=false', async () => {
    const ctx = createRuleContext({
      event: { type: 'schedule' },
      changedFilesStatus: 'unavailable',
    });
    const rules = [rule('reads changed files', (c) => c.changedFiles.length > 0)];
    await expect(evaluateRules(rules, ctx, 'job')).rejects.toBeInstanceOf(
      ChangedFilesUnavailableError,
    );
  });

  it('still folds a normal thrown error into passed=false', async () => {
    const ctx = createRuleContext({ event: { type: 'push' }, changedFilesStatus: 'fetched' });
    const rules = [
      rule('boom', () => {
        throw new Error('boom');
      }),
    ];
    const result = await evaluateRules(rules, ctx, 'job');
    expect(result.allPassed).toBe(false);
    expect(result.results[0].error).toContain('boom');
  });
});

describe('evaluateRules — evaluationError (throw vs clean false)', () => {
  const ctx = createRuleContext({ event: { type: 'push' }, changedFilesStatus: 'fetched' });

  it('all rules pass: allPassed true, no evaluationError', async () => {
    const result = await evaluateRules([rule('a', () => true), rule('b', () => true)], ctx, 'job');
    expect(result.allPassed).toBe(true);
    expect(result.evaluationError).toBeUndefined();
    expect(result.results).toHaveLength(2);
  });

  it('a rule cleanly returns false: allPassed false, NO evaluationError, fail-fast stops', async () => {
    const result = await evaluateRules([rule('a', () => false), rule('b', () => true)], ctx, 'job');
    expect(result.allPassed).toBe(false);
    expect(result.evaluationError).toBeUndefined();
    expect(result.results).toHaveLength(1); // fail-fast: second rule never evaluated
  });

  it('a rule check() throws: allPassed false, evaluationError set, remaining rules skipped', async () => {
    const result = await evaluateRules(
      [
        rule('boom', () => {
          throw new TypeError('kaboom');
        }),
        rule('never', () => true),
      ],
      ctx,
      'job',
    );
    expect(result.allPassed).toBe(false);
    expect(result.evaluationError).toEqual({ label: 'boom', message: 'kaboom' });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].error).toBe('kaboom');
  });

  it('the exact repro — reading an undefined event field throws a TypeError → evaluationError', async () => {
    // rule('main only', ctx => ctx.event.ref.endsWith('main')) on an event with
    // no ref: reading .endsWith on undefined throws a TypeError. This is the
    // finding's canonical repro — a crashed gate must NOT be a clean false.
    const noRefCtx = createRuleContext({ event: { type: 'push' }, changedFilesStatus: 'fetched' });
    const result = await evaluateRules(
      [rule('main only', (c) => (c.event as { ref?: string }).ref!.endsWith('main'))],
      noRefCtx,
      'job',
    );
    expect(result.allPassed).toBe(false);
    expect(result.evaluationError?.label).toBe('main only');
    expect(result.evaluationError?.message).toBeTruthy();
  });
});
