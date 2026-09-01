import { describe, it, expect } from 'vitest';
import picomatch from 'picomatch';
import { isNegatedPattern, negatedPatternReason } from './pattern-negation.js';

/**
 * Every arm is paired with the picomatch behaviour that justifies it, so a
 * future reader can see the inversion rather than take the ban list on faith.
 */
describe('negatedPatternReason', () => {
  it('names the leading-bang negation', () => {
    expect(negatedPatternReason('!myorg/x')).toMatch(/negation/);
  });

  it('names the extglob complement, which inverts wherever it appears', () => {
    expect(negatedPatternReason('myorg/!(secret)')).toMatch(/extglob/);
    expect(picomatch.isMatch('myorg/secret', 'myorg/!(secret)')).toBe(false);
    expect(picomatch.isMatch('myorg/app', 'myorg/!(secret)')).toBe(true);
  });

  it('names the negated character class', () => {
    expect(negatedPatternReason('myorg/[^s]*')).toMatch(/character-class/);
    expect(picomatch.isMatch('myorg/secret', 'myorg/[^s]*')).toBe(false);
    expect(picomatch.isMatch('myorg/app', 'myorg/[^s]*')).toBe(true);
  });

  it('names the negative lookahead, the widest of the four', () => {
    expect(negatedPatternReason('(?!myorg/secret)**')).toMatch(/assertion/);
    // A near-universal grant: every repository in every organization except
    // the one the pattern names.
    expect(picomatch.isMatch('myorg/secret', '(?!myorg/secret)**')).toBe(false);
    expect(picomatch.isMatch('myorg/app', '(?!myorg/secret)**')).toBe(true);
    expect(picomatch.isMatch('other/repo', '(?!myorg/secret)**')).toBe(true);

    expect(negatedPatternReason('myorg/(?!secret)*')).toMatch(/assertion/);
    expect(picomatch.isMatch('myorg/secret', 'myorg/(?!secret)*')).toBe(false);
    expect(picomatch.isMatch('myorg/app', 'myorg/(?!secret)*')).toBe(true);
  });

  it('names the negative lookbehind', () => {
    expect(negatedPatternReason('**(?<!secret)')).toMatch(/assertion/);
    expect(picomatch.isMatch('myorg/secret', '**(?<!secret)')).toBe(false);
    expect(picomatch.isMatch('myorg/app', '**(?<!secret)')).toBe(true);
  });

  it('accepts the [! class, which picomatch reads literally rather than as a negation', () => {
    // The inverse of `[^s]`: it admits the names beginning with `!` or `s`,
    // which is strictly less than it names. Do not add a `[!` arm.
    expect(negatedPatternReason('org/[!s]*')).toBeNull();
    expect(picomatch.isMatch('org/secret', 'org/[!s]*')).toBe(true);
    expect(picomatch.isMatch('org/app', 'org/[!s]*')).toBe(false);
  });

  it('accepts the positive assertions, a non-capturing group and a capture group', () => {
    expect(negatedPatternReason('myorg/(?=app)*')).toBeNull();
    expect(negatedPatternReason('myorg/(?<=app)*')).toBeNull();
    expect(negatedPatternReason('myorg/(?:app|api)')).toBeNull();
    expect(negatedPatternReason('myorg/(app|api)')).toBeNull();
  });

  it('accepts the non-complementing extglob heads', () => {
    for (const pattern of ['myorg/*(a|b)', 'myorg/+(a|b)', 'myorg/@(a|b)', 'myorg/?(a|b)']) {
      expect(negatedPatternReason(pattern)).toBeNull();
    }
  });

  it('accepts a literal bang inside a repository name', () => {
    expect(negatedPatternReason('org/we!rd')).toBeNull();
  });

  it('accepts ordinary globs, including a dot-prefixed repository name', () => {
    expect(negatedPatternReason('myorg/*')).toBeNull();
    expect(negatedPatternReason('**')).toBeNull();
    expect(negatedPatternReason('myorg/.github')).toBeNull();
    expect(negatedPatternReason('myorg/[abc]*')).toBeNull();
  });
});

describe('isNegatedPattern', () => {
  it('is the boolean face of the reason', () => {
    expect(isNegatedPattern('(?!myorg/secret)**')).toBe(true);
    expect(isNegatedPattern('org/[!s]*')).toBe(false);
  });
});
