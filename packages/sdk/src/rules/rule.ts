import type { Rule, RuleCheckFn } from './types.js';

/**
 * Create a rule with just a label (always passes): a marker in the decision trace.
 *
 * @example
 * const marker = rule('ci: required check');
 */
export function rule(label: string): Rule;

/**
 * Create a rule that passes when `check` returns true.
 *
 * @example
 * const hasFrontend = rule('skip: no frontend changes', async (ctx) => {
 *   return ctx.changedFiles.some(f => f.startsWith('src/ui/'));
 * });
 */
export function rule(label: string, check: RuleCheckFn): Rule;

export function rule(label: string, check?: RuleCheckFn): Rule {
  return {
    _tag: 'Rule' as const,
    label,
    check: check ?? (() => true),
  };
}

/**
 * Create a rule that skips when the condition is met: `rule()` with the check
 * inverted, so a `check` returning true skips and false runs.
 *
 * @example
 * // Skip when PR only contains docs changes
 * const skipDocsOnly = skip('docs only PR', async (ctx) => {
 *   return ctx.changedFiles.every(f => f.endsWith('.md'));
 * });
 */
export function skip(label: string, check: RuleCheckFn): Rule {
  return {
    _tag: 'Rule' as const,
    label,
    check: async (ctx) => !(await check(ctx)),
  };
}

/**
 * Run a step only on the first fan-out child (the lowest-`agentId` host, or the
 * first matrix variant). KiCI's `run_once`-on-the-first-host primitive.
 *
 * A non-fan-out job is treated as a single implicit child at index 0, so a step
 * gated this way runs normally there (there is exactly one host, which is first).
 *
 * @example
 * step('enable sync mode', async (ctx) => { ... }, { rules: [onlyOnFirstHost()] })
 */
export function onlyOnFirstHost(): Rule {
  return rule('fanout: first host only', (ctx) => ctx.fanout === undefined || ctx.fanout.first);
}

/**
 * Run a step only on the last fan-out child. Runs normally when not fanned out.
 */
export function onlyOnLastHost(): Rule {
  return rule('fanout: last host only', (ctx) => ctx.fanout === undefined || ctx.fanout.last);
}

/**
 * Run a step only on the fan-out child at index `n`. A non-fan-out job is the
 * implicit child at index 0, so `onlyOnFanoutIndex(0)` runs normally there.
 */
export function onlyOnFanoutIndex(n: number): Rule {
  return rule(`fanout: index ${n} only`, (ctx) => (ctx.fanout?.index ?? 0) === n);
}
