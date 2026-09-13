import { describe, it, expect } from 'vitest';
import { globSpecificityScore, compareGlobSpecificity } from './glob-specificity.js';

describe('globSpecificityScore', () => {
  it('counts literal chars and wildcards', () => {
    expect(globSpecificityScore('review/PR-*')).toEqual({ literals: 10, wildcards: 1 });
    expect(globSpecificityScore('review/*')).toEqual({ literals: 7, wildcards: 1 });
  });

  it('treats bracket, brace and extglob chars as wildcards', () => {
    // chars in {}[]()+@!*?| are wildcards; letters/digits/'/','-','.' are literals
    expect(globSpecificityScore('a[bc]')).toEqual({ literals: 3, wildcards: 2 }); // a,b,c literals; [ ] wildcards
    expect(globSpecificityScore('x{a,b}')).toEqual({ literals: 4, wildcards: 2 }); // x,a,',',b literals; { } wildcards
    expect(globSpecificityScore('+(y)')).toEqual({ literals: 1, wildcards: 3 }); // y literal; + ( ) wildcards
  });
});

describe('compareGlobSpecificity', () => {
  const ctx = (pattern: string, name = pattern) => ({ pattern, name });

  it('ranks more literal chars as more specific (negative => a first)', () => {
    expect(compareGlobSpecificity(ctx('review/PR-*'), ctx('review/*'))).toBeLessThan(0);
    expect(compareGlobSpecificity(ctx('review/*'), ctx('review/PR-*'))).toBeGreaterThan(0);
  });

  it('breaks equal-literal ties toward fewer wildcards', () => {
    const fewer = ctx('abcd*'); // literals 4, wildcards 1
    const more = ctx('a*b*cd'); // literals 4, wildcards 2
    expect(compareGlobSpecificity(fewer, more)).toBeLessThan(0);
  });

  it('breaks fully-equal specificity on name ascending (total order)', () => {
    const a = ctx('a-*', 'a-*');
    const b = ctx('b-*', 'b-*'); // same literals (2) + wildcards (1)
    expect(compareGlobSpecificity(a, b)).toBeLessThan(0);
    expect(compareGlobSpecificity(b, a)).toBeGreaterThan(0);
  });

  it('sorts a list most-specific-first', () => {
    const list = [ctx('review/*'), ctx('review/PR-*'), ctx('*')];
    const sorted = [...list].sort(compareGlobSpecificity).map((c) => c.pattern);
    expect(sorted).toEqual(['review/PR-*', 'review/*', '*']);
  });
});
