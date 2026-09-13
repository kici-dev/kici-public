import { describe, it, expect } from 'vitest';
import {
  LabelMatcher,
  matcherMatches,
  matcherSatisfiedBy,
  canonicalizeMatcher,
  compileRegexMatcher,
  partitionMatchers,
  hostSatisfiesTarget,
  HostTargetSelector,
} from './labels-match.js';
import { canonicalizeLabelSet } from './labels-canonical.js';

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
    const set = canonicalizeLabelSet(['kici:os:linux', 'kici:host:box-02']);
    expect(
      matcherSatisfiedBy(canonicalizeMatcher({ kind: 'exact', value: 'kici:os:linux' }), set),
    ).toBe(true);
    expect(
      matcherSatisfiedBy(
        canonicalizeMatcher({ kind: 'regex', source: '^kici:host:box-', flags: '' }),
        set,
      ),
    ).toBe(true);
    expect(matcherSatisfiedBy(canonicalizeMatcher({ kind: 'exact', value: 'gpu' }), set)).toBe(
      false,
    );
  });

  it('partitionMatchers splits exact strings from regex matchers', () => {
    const ms: LabelMatcher[] = [
      { kind: 'exact', value: 'a' },
      { kind: 'regex', source: 'b.*', flags: '' },
      { kind: 'exact', value: 'c' },
    ];
    expect(partitionMatchers(ms)).toEqual({
      exact: ['a', 'c'],
      // The regex half comes back canonical, so the fold rides on the `i` flag.
      regex: [{ kind: 'regex', source: 'b.*', flags: 'i' }],
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
    expect(hostSatisfiesTarget(canonicalizeLabelSet(['role:web', 'dc:eu']), t)).toBe(true);
    expect(hostSatisfiesTarget(canonicalizeLabelSet(['role:db']), t)).toBe(false);
  });

  it('AND-combines repeated values (every value must be satisfied)', () => {
    const t = HostTargetSelector.parse({
      values: [
        { include: [exact('role:web')], exclude: [] },
        { include: [exact('dc:eu')], exclude: [] },
      ],
      allowEmpty: false,
    });
    expect(hostSatisfiesTarget(canonicalizeLabelSet(['role:web', 'dc:eu']), t)).toBe(true);
    expect(hostSatisfiesTarget(canonicalizeLabelSet(['role:web', 'dc:us']), t)).toBe(false);
  });

  it('rejects a host matched by an exclude matcher', () => {
    const t = HostTargetSelector.parse({
      values: [{ include: [exact('role:web')], exclude: [exact('canary')] }],
      allowEmpty: false,
    });
    expect(hostSatisfiesTarget(canonicalizeLabelSet(['role:web', 'canary']), t)).toBe(false);
    expect(hostSatisfiesTarget(canonicalizeLabelSet(['role:web']), t)).toBe(true);
  });

  it('requires every include matcher within a value (AND inside a value)', () => {
    const t = HostTargetSelector.parse({
      values: [{ include: [exact('role:web'), exact('dc:eu')], exclude: [] }],
      allowEmpty: false,
    });
    expect(hostSatisfiesTarget(canonicalizeLabelSet(['role:web', 'dc:eu']), t)).toBe(true);
    expect(hostSatisfiesTarget(canonicalizeLabelSet(['role:web']), t)).toBe(false);
  });

  it('schema requires at least one value', () => {
    expect(HostTargetSelector.safeParse({ values: [], allowEmpty: false }).success).toBe(false);
  });
});

describe('LabelMatcher — stateful regex flags', () => {
  it('matches the same single label on every call with a g-flagged matcher', () => {
    const m: LabelMatcher = { kind: 'regex', source: '^linux-.*', flags: 'g' };
    expect(matcherMatches(m, 'linux-x64')).toBe(true);
    expect(matcherMatches(m, 'linux-x64')).toBe(true);
    expect(matcherMatches(m, 'linux-arm64')).toBe(true);
  });

  it('finds a match anywhere in the set, not only on the first probe', () => {
    // The set loop reuses one compiled instance; a sticky one would resume from
    // lastIndex on the second label and miss it.
    const m: LabelMatcher = { kind: 'regex', source: '^linux-.*', flags: 'g' };
    expect(
      matcherSatisfiedBy(canonicalizeMatcher(m), canonicalizeLabelSet(['linux-a', 'linux-b'])),
    ).toBe(true);
    // Ordering is not guaranteed, so probe a set whose only match is not first.
    expect(
      matcherSatisfiedBy(canonicalizeMatcher(m), canonicalizeLabelSet(['darwin-a', 'linux-b'])),
    ).toBe(true);
    expect(
      matcherSatisfiedBy(canonicalizeMatcher(m), canonicalizeLabelSet(['darwin-a', 'darwin-b'])),
    ).toBe(false);
  });

  it('drops g and y from the compiled instance', () => {
    expect(compileRegexMatcher({ source: 'abc', flags: 'gimy' }).flags).toBe('im');
  });
});

describe('case-insensitive label matching', () => {
  it('matches an exact matcher against a differently-cased label', () => {
    const m = canonicalizeMatcher({ kind: 'exact', value: 'Docker' });
    expect(matcherSatisfiedBy(m, canonicalizeLabelSet(['docker']))).toBe(true);
  });

  it('matches a glob-derived regex against a differently-cased label', () => {
    // The shape picomatch emits for 'kici:host:Web-*'.
    const m = canonicalizeMatcher({
      kind: 'regex',
      source: '^(?:kici:host:Web\\-[^/]*?)$',
      flags: '',
    });
    expect(matcherSatisfiedBy(m, canonicalizeLabelSet(['kici:host:web-01']))).toBe(true);
  });

  it('preserves an author-supplied i flag rather than duplicating it', () => {
    const m = canonicalizeMatcher({ kind: 'regex', source: 'gpu', flags: 'i' });
    expect(m.kind === 'regex' && m.flags).toBe('i');
  });

  it('still strips the stateful flags while forcing i', () => {
    const m = canonicalizeMatcher({ kind: 'regex', source: 'gpu', flags: 'g' });
    expect(m.kind === 'regex' && m.flags.split('').sort().join('')).toBe('i');
  });

  it('leaves the regex source byte-identical, so surrounding space still counts', () => {
    // Trimming an exact value is right — the agent side trims too. Trimming a
    // regex source is not: ' gpu ' matches a different set of labels than 'gpu'.
    const m = canonicalizeMatcher({ kind: 'regex', source: ' gpu ', flags: '' });
    expect(m.kind === 'regex' && m.source).toBe(' gpu ');
    expect(matcherSatisfiedBy(m, canonicalizeLabelSet(['GPU']))).toBe(false);
    expect(matcherSatisfiedBy(m, canonicalizeLabelSet(['a GPU b']))).toBe(true);
  });

  it('partitionMatchers folds exact values and forces i on the regex half', () => {
    const { exact, regex } = partitionMatchers([
      { kind: 'exact', value: 'GPU' },
      { kind: 'regex', source: 'Web-.*', flags: '' },
    ]);
    expect(exact).toEqual(['gpu']);
    expect(regex[0]?.kind === 'regex' && regex[0].flags).toContain('i');
  });

  // The security boundary: matcherMatches is what matchHostPattern uses to
  // compare agent IDs and hostnames, and must stay case-sensitive.
  it('leaves matcherMatches case-sensitive so host patterns do not widen', () => {
    expect(matcherMatches({ kind: 'exact', value: 'Prod-01' }, 'prod-01')).toBe(false);
    expect(matcherMatches({ kind: 'regex', source: '^prod-', flags: '' }, 'PROD-01')).toBe(false);
  });
});
