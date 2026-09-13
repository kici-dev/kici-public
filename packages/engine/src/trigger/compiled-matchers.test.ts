import { describe, it, expect } from 'vitest';
import picomatch from 'picomatch';
import { getCompiledRegex, getGlobMatcher, getRepoGlobMatcher } from './compiled-matchers.js';

describe('getCompiledRegex', () => {
  it('returns the same RegExp instance for identical pattern+flags', () => {
    const a = getCompiledRegex('^v\\d+$', 'i');
    const b = getCompiledRegex('^v\\d+$', 'i');
    expect(a).toBe(b);
  });

  it('distinguishes flags', () => {
    expect(getCompiledRegex('abc', 'i')).not.toBe(getCompiledRegex('abc', undefined));
  });

  it('compiles a working regex', () => {
    expect(getCompiledRegex('^rel-', undefined).test('rel-1')).toBe(true);
    expect(getCompiledRegex('^rel-', undefined).test('dev-1')).toBe(false);
  });

  it('matches identically to a freshly-compiled RegExp over a corpus', () => {
    const cases: Array<[string, string | undefined, string]> = [
      ['^v\\d+$', undefined, 'v12'],
      ['^v\\d+$', 'i', 'V12'],
      ['release/.*', undefined, 'release/1.0'],
      ['\\bhotfix\\b', 'i', 'A HOTFIX here'],
      ['^main$', undefined, 'develop'],
    ];
    for (const [pattern, flags, input] of cases) {
      expect(getCompiledRegex(pattern, flags).test(input)).toBe(
        new RegExp(pattern, flags).test(input),
      );
    }
  });
});

describe('getGlobMatcher', () => {
  it('returns the same matcher fn for the same pattern', () => {
    expect(getGlobMatcher('src/**')).toBe(getGlobMatcher('src/**'));
  });

  it('matches like picomatch', () => {
    const m = getGlobMatcher('src/**/*.ts');
    expect(m('src/a/b.ts')).toBe(true);
    expect(m('lib/a.ts')).toBe(false);
  });

  it('matches identically to picomatch.isMatch over a corpus', () => {
    const cases: Array<[string, string]> = [
      ['src/**', 'src/a/b.ts'],
      ['src/**/*.ts', 'src/a/b.ts'],
      ['*.md', 'README.md'],
      ['docs/*', 'docs/guide.md'],
      ['docs/*', 'docs/a/b.md'],
      ['**/*.test.ts', 'packages/x/y.test.ts'],
    ];
    for (const [pattern, input] of cases) {
      expect(getGlobMatcher(pattern)(input)).toBe(picomatch.isMatch(input, pattern));
    }
  });
});

describe('getRepoGlobMatcher', () => {
  it('returns the same matcher fn for the same pattern', () => {
    expect(getRepoGlobMatcher('myorg/*')).toBe(getRepoGlobMatcher('myorg/*'));
  });

  it('is a distinct matcher from the shared one for the same pattern', () => {
    expect(getRepoGlobMatcher('**')).not.toBe(getGlobMatcher('**'));
  });

  it('matches a dot-prefixed repo identifier that the default matcher excludes', () => {
    expect(getGlobMatcher('**')('.hidden/repo')).toBe(false); // the default, unchanged
    expect(getRepoGlobMatcher('**')('.hidden/repo')).toBe(true);
  });

  it('still matches ordinary identifiers', () => {
    expect(getRepoGlobMatcher('**')('acme/canary')).toBe(true);
    expect(getRepoGlobMatcher('myorg/*')('myorg/app')).toBe(true);
    expect(getRepoGlobMatcher('myorg/*')('other/app')).toBe(false);
  });

  it('does NOT match a bare "." — dot: true does not change that', () => {
    // Recorded so nobody "fixes" this by widening the option further: picomatch
    // will not match a lone '.' in either mode.
    expect(getRepoGlobMatcher('**')('.')).toBe(false);
  });

  it('leaves path matching alone', () => {
    // The shared matcher must keep its existing semantics: a path glob that did
    // not match a dotfile before must still not match one.
    expect(getGlobMatcher('**')('.github/workflows/ci.yml')).toBe(false);
  });
});

describe('getCompiledRegex — stateful flags', () => {
  it('gives the same verdict on repeated calls with a g-flagged pattern', () => {
    // A memoized g-flagged RegExp carries lastIndex, so the second .test() of
    // the same input would start mid-string and report false.
    const re = getCompiledRegex('^release-\\d+', 'g');
    expect(re.test('release-1')).toBe(true);
    expect(re.test('release-2')).toBe(true);
    expect(re.test('release-3')).toBe(true);
  });

  it('gives the same verdict on repeated calls with a y-flagged pattern', () => {
    const re = getCompiledRegex('^release-\\d+', 'y');
    expect(re.test('release-1')).toBe(true);
    expect(re.test('release-2')).toBe(true);
  });

  it('drops g and y from the compiled instance', () => {
    expect(getCompiledRegex('abc', 'gimy').flags).toBe('im');
  });

  it('preserves every non-stateful flag, including d and v', () => {
    // `u` and `v` are mutually exclusive, so `v` stands in for both here.
    expect(getCompiledRegex('abc', 'dgimsvy').flags).toBe('dimsv');
  });

  it('memoizes a stripped and an unstripped flag string to one instance', () => {
    // The strip happens before the memo key, so /x/g and /x/ are the same entry
    // — which is what makes the cache sound rather than merely smaller.
    expect(getCompiledRegex('memo-shared', 'g')).toBe(getCompiledRegex('memo-shared', ''));
  });
});
