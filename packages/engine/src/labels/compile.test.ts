import { describe, it, expect } from 'vitest';
import {
  toLabelMatcher,
  assertSafeRegex,
  normalizeRunsOnToMatchers,
  normalizeRunsOnAllToMatchers,
  assertMatchersSafe,
  runsOnPickFromInput,
} from './compile.js';

describe('toLabelMatcher', () => {
  it('plain string with no metachars → exact', () => {
    expect(toLabelMatcher('kici:os:linux', 'job a')).toEqual({
      kind: 'exact',
      value: 'kici:os:linux',
    });
  });

  it('hyphen/colon are not glob metachars → exact', () => {
    expect(toLabelMatcher('kici:host:box-01', 'job a')).toEqual({
      kind: 'exact',
      value: 'kici:host:box-01',
    });
  });

  it('string with glob metachars → regex (via picomatch)', () => {
    const m = toLabelMatcher('kici:host:box-*', 'job a');
    expect(m.kind).toBe('regex');
    if (m.kind === 'regex') {
      const re = new RegExp(m.source, m.flags);
      expect(re.test('kici:host:box-01')).toBe(true);
      expect(re.test('kici:host:web-01')).toBe(false);
    }
  });

  it('RegExp instance → regex capturing source + flags', () => {
    expect(toLabelMatcher(/box-0[1-3]/i, 'job a')).toEqual({
      kind: 'regex',
      source: 'box-0[1-3]',
      flags: 'i',
    });
  });

  it('rejects a ReDoS-prone RegExp at compile time', () => {
    expect(() => toLabelMatcher(/(a+)+$/, "job 'web'")).toThrow(/ReDoS-prone/);
  });
});

describe('assertSafeRegex', () => {
  it('accepts a benign pattern', () => {
    expect(() => assertSafeRegex('^kici:host:box-', '', 'ctx')).not.toThrow();
  });
  it('rejects nested quantifiers with context', () => {
    expect(() => assertSafeRegex('(a+)+$', '', "job 'web' runsOn")).toThrow(/job 'web' runsOn/);
  });
});

describe('normalizeRunsOnToMatchers', () => {
  it('string shorthand → one exact include, no exclude', () => {
    expect(normalizeRunsOnToMatchers('kici:os:linux', 'job a')).toEqual({
      include: [{ kind: 'exact', value: 'kici:os:linux' }],
      exclude: [],
    });
  });
  it('selector with glob + regex exclude', () => {
    const out = normalizeRunsOnToMatchers(
      { labels: ['kici:gpu', 'rack-[0-9]*'], exclude: [/.*-canary$/] },
      'job a',
    );
    expect(out.include[0]).toEqual({ kind: 'exact', value: 'kici:gpu' });
    expect(out.include[1].kind).toBe('regex'); // glob 'rack-[0-9]*'
    expect(out.exclude[0]).toEqual({ kind: 'regex', source: '.*-canary$', flags: '' });
  });
});

describe('normalizeRunsOnAllToMatchers', () => {
  it('array form: ! routes to exclude, glob detected after stripping !', () => {
    const out = normalizeRunsOnAllToMatchers(['kici:os:linux', '!box-*'], 'job a');
    expect(out.include).toEqual([[{ kind: 'exact', value: 'kici:os:linux' }]]);
    expect(out.exclude[0].kind).toBe('regex'); // glob 'box-*' after '!' strip
  });
  it('structured include groups + regex exclude', () => {
    const out = normalizeRunsOnAllToMatchers(
      { include: [{ all: ['kici:os:linux', 'web-*'] }], exclude: [/.*-canary$/] },
      'job a',
    );
    expect(out.include[0][0]).toEqual({ kind: 'exact', value: 'kici:os:linux' });
    expect(out.include[0][1].kind).toBe('regex');
    expect(out.exclude[0]).toEqual({ kind: 'regex', source: '.*-canary$', flags: '' });
  });
});

describe('assertMatchersSafe', () => {
  it('passes a list of exact + benign regex matchers', () => {
    expect(() =>
      assertMatchersSafe(
        [
          { kind: 'exact', value: 'a' },
          { kind: 'regex', source: '^box-', flags: '' },
        ],
        'lock job web runsOn',
      ),
    ).not.toThrow();
  });
  it('throws on a smuggled ReDoS regex matcher', () => {
    expect(() =>
      assertMatchersSafe([{ kind: 'regex', source: '(a+)+$', flags: '' }], 'lock job web runsOn'),
    ).toThrow(/ReDoS-prone/);
  });
});

describe('runsOnPickFromInput', () => {
  it('defaults string + array shorthand to deterministic', () => {
    expect(runsOnPickFromInput('kici:group:ops')).toBe('deterministic');
    expect(runsOnPickFromInput(['a', 'b'])).toBe('deterministic');
  });

  it('defaults a selector without pick to deterministic', () => {
    expect(runsOnPickFromInput({ labels: ['role:db'] })).toBe('deterministic');
  });

  it('preserves an explicit pick on the selector', () => {
    expect(runsOnPickFromInput({ labels: ['role:db'], pick: 'any' })).toBe('any');
    expect(runsOnPickFromInput({ labels: ['role:db'], pick: 'deterministic' })).toBe(
      'deterministic',
    );
  });
});
