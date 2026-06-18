import { describe, it, expect } from 'vitest';
import {
  LabelMatcher,
  matcherMatches,
  matcherSatisfiedBy,
  partitionMatchers,
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

  it('Zod schema rejects an unknown kind', () => {
    expect(LabelMatcher.safeParse({ kind: 'glob', value: 'x' }).success).toBe(false);
  });
});
