import { describe, it, expect } from 'vitest';
import { buildGeneratorContext } from './generator-context.js';

const base = {
  workflowName: 'org-ci',
  event: { type: 'push', targetBranch: 'main' },
  env: { FOO: 'bar' },
  $: (() => {}) as never,
  log: { info() {}, warn() {}, error() {}, debug() {} } as never,
  kici: {} as never,
};

const repos = {
  sourceRepo: { identifier: 'o/src', path: '/w/source', ref: 'main', sha: 'aaa' },
  workflowRepo: { identifier: 'o/wf', path: '/w/workflow', ref: 'main', sha: 'bbb' },
};

describe('buildGeneratorContext', () => {
  it('exposes the repo pair at the top level when supplied', () => {
    const ctx = buildGeneratorContext({ ...base, repos });
    expect(ctx.sourceRepo).toEqual(repos.sourceRepo);
    expect(ctx.workflowRepo).toEqual(repos.workflowRepo);
  });

  it('omits the pair when not supplied', () => {
    const ctx = buildGeneratorContext(base);
    expect(ctx.sourceRepo).toBeUndefined();
    expect(ctx.workflowRepo).toBeUndefined();
    // Absent, not present-and-undefined: a `sourceRepo: undefined` key would
    // still serialize into a lock job and read as "the field exists".
    expect(Object.hasOwn(ctx, 'sourceRepo')).toBe(false);
    expect(Object.hasOwn(ctx, 'workflowRepo')).toBe(false);
  });

  it('carries the event envelope and workflow name onto ctx', () => {
    const ctx = buildGeneratorContext({ ...base, repos });
    expect(ctx.ctx.workflow).toEqual({ name: 'org-ci' });
    expect(ctx.ctx.event).toEqual(base.event);
    expect(ctx.env).toEqual(base.env);
    // `needs` is absent unless supplied — a present-but-undefined `needs` would
    // make `ctx.needs` look declared to a result-aware generator.
    expect(Object.hasOwn(ctx.ctx, 'needs')).toBe(false);
  });

  it('produces a deep-equal context for two calls with equal input', () => {
    const a = buildGeneratorContext({ ...base, repos });
    const b = buildGeneratorContext({ ...base, repos });

    // The whole serializable surface, so a new context field is covered without
    // touching this test. $ / log / kici are identity-compared below.
    expect(a).toEqual(b);

    // Positive control: if `repos` stopped reaching the context, this would
    // deep-equal `a` and the determinism assertion would be vacuous.
    const divergent = buildGeneratorContext({
      ...base,
      repos: { ...repos, sourceRepo: { ...repos.sourceRepo, sha: 'ccc' } },
    });
    expect(a).not.toEqual(divergent);

    // The SAME injected collaborators, not structurally-equal ones: `toEqual` on
    // an empty `kici` stub is vacuous.
    expect(a.$).toBe(b.$);
    expect(a.log).toBe(b.log);
    expect(a.kici).toBe(b.kici);

    // Key ORDER too: equal values built in another order serialize differently.
    expect(Object.keys(a)).toEqual(Object.keys(b));
    expect(Object.keys(a.ctx)).toEqual(Object.keys(b.ctx));
  });
});
