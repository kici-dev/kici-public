import { describe, it, expect, vi } from 'vitest';
import type { Rule, RuleContext } from '@kici-dev/sdk';
import { evaluateRules, createRuleContext } from './rule-evaluator.js';

function makeRule(label: string, check: Rule['check']): Rule {
  return { _tag: 'Rule', label, check };
}

function makeContext(): RuleContext {
  return createRuleContext({ type: 'push' }, ['src/index.ts'], { NODE_ENV: 'test' });
}

describe('evaluateRules', () => {
  it('single passing rule returns allPassed: true', async () => {
    const rules = [makeRule('always-pass', () => true)];
    const result = await evaluateRules(rules, makeContext(), 'test-job');

    expect(result.allPassed).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].label).toBe('always-pass');
    expect(result.results[0].passed).toBe(true);
  });

  it('single failing rule returns allPassed: false', async () => {
    const rules = [makeRule('always-fail', () => false)];
    const result = await evaluateRules(rules, makeContext(), 'test-job');

    expect(result.allPassed).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].passed).toBe(false);
  });

  it('fail-fast: first failure stops evaluation of remaining rules', async () => {
    const secondCheck = vi.fn().mockReturnValue(true);
    const rules = [makeRule('fail', () => false), makeRule('never-reached', secondCheck)];

    const result = await evaluateRules(rules, makeContext(), 'test-job');

    expect(result.allPassed).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].label).toBe('fail');
    expect(secondCheck).not.toHaveBeenCalled();
  });

  it('all rules pass when all return true', async () => {
    const rules = [
      makeRule('rule-1', () => true),
      makeRule('rule-2', () => true),
      makeRule('rule-3', () => true),
    ];

    const result = await evaluateRules(rules, makeContext(), 'test-job');

    expect(result.allPassed).toBe(true);
    expect(result.results).toHaveLength(3);
    expect(result.results.every((r) => r.passed)).toBe(true);
  });

  it('middle rule fails: earlier pass, middle fails, later not evaluated', async () => {
    const thirdCheck = vi.fn().mockReturnValue(true);
    const rules = [
      makeRule('pass', () => true),
      makeRule('fail', () => false),
      makeRule('never-reached', thirdCheck),
    ];

    const result = await evaluateRules(rules, makeContext(), 'test-job');

    expect(result.allPassed).toBe(false);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].passed).toBe(true);
    expect(result.results[1].passed).toBe(false);
    expect(thirdCheck).not.toHaveBeenCalled();
  });

  it('async rule works correctly', async () => {
    const rules = [
      makeRule('async-pass', async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return true;
      }),
    ];

    const result = await evaluateRules(rules, makeContext(), 'test-job');

    expect(result.allPassed).toBe(true);
    expect(result.results[0].passed).toBe(true);
  });

  it('rule that throws returns failed with error message', async () => {
    const rules = [
      makeRule('throws', () => {
        throw new Error('something went wrong');
      }),
    ];

    const result = await evaluateRules(rules, makeContext(), 'test-job');

    expect(result.allPassed).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].passed).toBe(false);
    expect(result.results[0].error).toBe('something went wrong');
  });

  it('rule that throws non-Error is captured as string', async () => {
    const rules = [
      makeRule('throws-string', () => {
        throw 'raw string error';
      }),
    ];

    const result = await evaluateRules(rules, makeContext(), 'test-job');

    expect(result.allPassed).toBe(false);
    expect(result.results[0].error).toBe('raw string error');
  });

  it('timing recorded per rule', async () => {
    const rules = [makeRule('timed', () => true)];
    const result = await evaluateRules(rules, makeContext(), 'test-job');

    expect(typeof result.results[0].durationMs).toBe('number');
    expect(result.results[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('empty rules array returns allPassed: true', async () => {
    const result = await evaluateRules([], makeContext(), 'test-job');

    expect(result.allPassed).toBe(true);
    expect(result.results).toHaveLength(0);
  });
});

describe('createRuleContext', () => {
  it('creates context with event, changedFiles, and env', () => {
    const ctx = createRuleContext({ type: 'pr:open', pr: 42 }, ['file.ts'], { CI: 'true' });

    expect(ctx.event).toEqual({ type: 'pr:open', pr: 42 });
    expect(ctx.changedFiles).toEqual(['file.ts']);
    expect(ctx.env).toEqual({ CI: 'true' });
    expect(ctx.$).toBeDefined();
  });

  it('defaults changedFiles and env when not provided', () => {
    const ctx = createRuleContext({ type: 'push' });

    expect(ctx.changedFiles).toEqual([]);
    expect(ctx.env).toEqual({});
  });
});
