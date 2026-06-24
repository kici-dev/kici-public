import { describe, it, expect } from 'vitest';
import {
  LabelMatcher,
  matcherMatches,
  matcherSatisfiedBy,
  partitionMatchers,
  hostSatisfiesTarget,
  HostTargetSelector,
} from './labels-match.js';

describe('LabelMatcher eval', () => {
  it('exact matcher matches only the identical label', () => {
    const m: LabelMatcher = { kind: 'exact', value: 'kici:os:linux' };
    expect(matcherMatches(m, 'kici:os:linux')).toBe(true);
    expect(matcherMatches(m, 'kici:os:linuxx')).toBe(false);
  });

  it('regex matcher tests the label', () => {
    const m: LabelMatcher = { kind: 'regex', source: '^kici:host:box-0[1-3]$', flags: '' };
    expect(matcherMatches(m, 'kici:host:box-02')).toBe(true);
    expect(matcherMatches(m, 'kici:host:box-09')).toBe(false);
  });

  it('matcherSatisfiedBy returns true when some label in the set matches', () => {
    const set = new Set(['kici:os:linux', 'kici:host:box-02']);
    expect(matcherSatisfiedBy({ kind: 'exact', value: 'kici:os:linux' }, set)).toBe(true);
    expect(matcherSatisfiedBy({ kind: 'regex', source: '^kici:host:box-', flags: '' }, set)).toBe(
      true,
    );
    expect(matcherSatisfiedBy({ kind: 'exact', value: 'gpu' }, set)).toBe(false);
  });

  it('partitionMatchers splits exact strings from regex matchers', () => {
    const ms: LabelMatcher[] = [
      { kind: 'exact', value: 'a' },
      { kind: 'regex', source: 'b.*', flags: '' },
      { kind: 'exact', value: 'c' },
    ];
    expect(partitionMatchers(ms)).toEqual({
      exact: ['a', 'c'],
      regex: [{ kind: 'regex', source: 'b.*', flags: '' }],
    });
  });

  it('partitionMatchers throws on a non-matcher element (stale string-array runsOn)', () => {
    // A v19 lock stored runsOn as a plain string array; each element has no `kind`.
    const stale = ['firecracker', 'arm64'] as unknown as LabelMatcher[];
    expect(() => partitionMatchers(stale)).toThrow(/recompile/i);
  });

  it('partitionMatchers returns empty partitions for an empty list', () => {
    expect(partitionMatchers([])).toEqual({ exact: [], regex: [] });
  });

  it('Zod schema rejects an unknown kind', () => {
    expect(LabelMatcher.safeParse({ kind: 'glob', value: 'x' }).success).toBe(false);
  });
});

describe('hostSatisfiesTarget', () => {
  const exact = (value: string) => ({ kind: 'exact' as const, value });

  it('passes a host whose labels satisfy the single value', () => {
    const t = HostTargetSelector.parse({
      values: [{ include: [exact('role:web')], exclude: [] }],
      allowEmpty: false,
    });
    expect(hostSatisfiesTarget(new Set(['role:web', 'dc:eu']), t)).toBe(true);
    expect(hostSatisfiesTarget(new Set(['role:db']), t)).toBe(false);
  });

  it('AND-combines repeated values (every value must be satisfied)', () => {
    const t = HostTargetSelector.parse({
      values: [
        { include: [exact('role:web')], exclude: [] },
        { include: [exact('dc:eu')], exclude: [] },
      ],
      allowEmpty: false,
    });
    expect(hostSatisfiesTarget(new Set(['role:web', 'dc:eu']), t)).toBe(true);
    expect(hostSatisfiesTarget(new Set(['role:web', 'dc:us']), t)).toBe(false);
  });

  it('rejects a host matched by an exclude matcher', () => {
    const t = HostTargetSelector.parse({
      values: [{ include: [exact('role:web')], exclude: [exact('canary')] }],
      allowEmpty: false,
    });
    expect(hostSatisfiesTarget(new Set(['role:web', 'canary']), t)).toBe(false);
    expect(hostSatisfiesTarget(new Set(['role:web']), t)).toBe(true);
  });

  it('requires every include matcher within a value (AND inside a value)', () => {
    const t = HostTargetSelector.parse({
      values: [{ include: [exact('role:web'), exact('dc:eu')], exclude: [] }],
      allowEmpty: false,
    });
    expect(hostSatisfiesTarget(new Set(['role:web', 'dc:eu']), t)).toBe(true);
    expect(hostSatisfiesTarget(new Set(['role:web']), t)).toBe(false);
  });

  it('schema requires at least one value', () => {
    expect(HostTargetSelector.safeParse({ values: [], allowEmpty: false }).success).toBe(false);
  });
});
