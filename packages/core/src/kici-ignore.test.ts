import { describe, it, expect } from 'vitest';
import {
  KICI_DIGEST_DEFAULT_EXCLUSIONS,
  KICI_DIGEST_FORCED_EXCLUSIONS,
  KICI_RUN_REWRITTEN_PATHS,
  parseKiciIgnore,
  buildKiciIgnoreMatcher,
} from './kici-ignore.js';

describe('parseKiciIgnore', () => {
  it('drops blank lines, comments and surrounding whitespace', () => {
    expect(
      parseKiciIgnore(
        ['# a comment', '', '  node_modules/  ', '\t', '.npmrc', '# trailing'].join('\n'),
      ),
    ).toEqual(['node_modules/', '.npmrc']);
  });

  it('keeps a literal "#" that is escaped, so a file named "#x" is expressible', () => {
    expect(parseKiciIgnore('\\#x')).toEqual(['#x']);
  });

  it('returns an empty list for a file that is only comments', () => {
    // An empty list is NOT the same as an absent file: under replace
    // semantics it means "exclude nothing but the forced entry".
    expect(parseKiciIgnore('# nothing here\n\n')).toEqual([]);
  });
});

describe('buildKiciIgnoreMatcher', () => {
  it('matches a bare name at any depth, like gitignore', () => {
    const m = buildKiciIgnoreMatcher(['.npmrc']);
    expect(m('.npmrc', false)).toBe(true);
    expect(m('nested/deep/.npmrc', false)).toBe(true);
    expect(m('npmrc', false)).toBe(false);
  });

  it('matches a directory pattern and everything beneath it', () => {
    const m = buildKiciIgnoreMatcher(['node_modules/']);
    expect(m('node_modules', true)).toBe(true);
    expect(m('node_modules/pkg/index.js', false)).toBe(true);
    expect(m('lib/node_modules/pkg/index.js', false)).toBe(true);
    // A directory pattern must not match a plain FILE of that name.
    expect(m('node_modules', false)).toBe(false);
  });

  it('anchors a pattern that carries a leading slash', () => {
    const m = buildKiciIgnoreMatcher(['/package-lock.json']);
    expect(m('package-lock.json', false)).toBe(true);
    expect(m('nested/package-lock.json', false)).toBe(false);
  });

  it('anchors a pattern with an interior slash', () => {
    const m = buildKiciIgnoreMatcher(['types/secrets.d.ts']);
    expect(m('types/secrets.d.ts', false)).toBe(true);
    expect(m('nested/types/secrets.d.ts', false)).toBe(false);
  });

  it('supports * (not crossing a slash) and ** (crossing slashes)', () => {
    const star = buildKiciIgnoreMatcher(['*.log']);
    expect(star('a.log', false)).toBe(true);
    expect(star('deep/a.log', false)).toBe(true);

    const anchoredStar = buildKiciIgnoreMatcher(['/build/*.js']);
    expect(anchoredStar('build/a.js', false)).toBe(true);
    expect(anchoredStar('build/nested/a.js', false)).toBe(false);

    const globstar = buildKiciIgnoreMatcher(['/build/**/*.js']);
    expect(globstar('build/nested/deep/a.js', false)).toBe(true);
  });

  it('supports a ? single-character wildcard', () => {
    const m = buildKiciIgnoreMatcher(['a?.ts']);
    expect(m('ab.ts', false)).toBe(true);
    expect(m('abc.ts', false)).toBe(false);
  });

  it('treats regex metacharacters in a pattern as literals', () => {
    const m = buildKiciIgnoreMatcher(['a+b(c).ts']);
    expect(m('a+b(c).ts', false)).toBe(true);
    expect(m('aab(c).ts', false)).toBe(false);
  });

  it('re-includes a path with a ! negation, last match winning', () => {
    const m = buildKiciIgnoreMatcher(['*.json', '!keep.json']);
    expect(m('drop.json', false)).toBe(true);
    expect(m('keep.json', false)).toBe(false);
  });

  it('matches nothing when given no patterns', () => {
    const m = buildKiciIgnoreMatcher([]);
    expect(m('anything.ts', false)).toBe(false);
  });
});

describe('the declared constant sets', () => {
  it('carries exactly the ruled default set', () => {
    expect([...KICI_DIGEST_DEFAULT_EXCLUSIONS]).toEqual([
      'node_modules/',
      'types/',
      '.npmrc',
      'package-lock.json',
      'pnpm-lock.yaml',
      'kici.lock.json',
    ]);
  });

  it('forces kici.lock.json, because the digest is written into it', () => {
    expect([...KICI_DIGEST_FORCED_EXCLUSIONS]).toEqual(['kici.lock.json']);
  });

  it('names the paths a run rewrites, for the footgun warning', () => {
    expect([...KICI_RUN_REWRITTEN_PATHS].sort()).toEqual([
      '.npmrc',
      'node_modules/',
      'package-lock.json',
    ]);
  });

  it('names every run-rewritten path in the default set, so the default never warns', () => {
    for (const p of KICI_RUN_REWRITTEN_PATHS) {
      expect(KICI_DIGEST_DEFAULT_EXCLUSIONS).toContain(p);
    }
  });
});
