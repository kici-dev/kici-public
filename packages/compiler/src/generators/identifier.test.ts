import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { isValidIdentifier, toIdentifier } from './identifier.js';

/** Whether TypeScript's own scanner reads `text` as exactly one identifier token. */
function scansAsOneIdentifier(text: string): boolean {
  const scanner = ts.createScanner(
    ts.ScriptTarget.ES2024,
    false,
    ts.LanguageVariant.Standard,
    text,
  );
  return scanner.scan() === ts.SyntaxKind.Identifier && scanner.getTokenEnd() === text.length;
}

describe('toIdentifier', () => {
  it.each([
    ['main', 'pushMain'],
    ['ci/kici', 'pushCiKici'],
    ['release-1.2', 'pushRelease12'],
    ['user@host', 'pushUserHost'],
    ["feat/it's-x", 'pushFeatItSX'],
    ['feature/ABC-123', 'pushFeatureABC123'],
    // Precomposed accents fold to their base letter.
    ['café/naïve', 'pushCafeNaive'],
    // The ligature U+FB01 decomposes to "fi" only under compatibility (NFKD) normalization.
    ['ﬁx', 'pushFix'],
    // Nothing ASCII survives.
    ['分支', 'pushBranch'],
    ['2024', 'push2024'],
    ['', 'pushBranch'],
    ['/-.@', 'pushBranch'],
  ])('push + %j -> %s', (raw, expected) => {
    const id = toIdentifier('push', raw);
    // fails-when: a separator survives into the name (`pushCi/kici`), or NFD replaces NFKD
    // (the U+FB01 ligature then drops out and yields `pushX`)
    expect(id).toBe(expected);
    // fails-when: the result is not an identifier for TypeScript's own scanner
    expect(scansAsOneIdentifier(id)).toBe(true);
  });

  it('falls back to prefix + Branch when the joined name cannot start an identifier', () => {
    // fails-when: a digit-led result is returned as-is
    expect(toIdentifier('', '2024')).toBe('Branch');
    // breaks-if-wrong: an empty prefix still PascalCases an ordinary name
    expect(toIdentifier('', 'ci/kici')).toBe('CiKici');
  });

  it('refuses a prefix that cannot start an identifier', () => {
    expect(() => toIdentifier('9', '')).toThrow(/cannot start an identifier/);
  });
});

describe('isValidIdentifier', () => {
  it.each([
    ['abc', true],
    ['_x', true],
    ['$y', true],
    ['a1', true],
    ['', false],
    ['1a', false],
    ['a-b', false],
    ['a/b', false],
    ['café', false],
  ])('%j -> %s', (name, valid) => {
    expect(isValidIdentifier(name)).toBe(valid);
  });
});
