import { describe, it, expect } from 'vitest';
import { isCiEnvironment, isCiMarkerSet } from './ci-env.js';

describe('isCiMarkerSet', () => {
  it.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['yes', true],
    ['0', false],
    ['false', false],
    ['False', false],
    ['FALSE', false],
    [' false ', false],
    ['', false],
    // Whitespace-only is "unset-looking", so it must not read as CI — the
    // emptiness check runs on the trimmed value for exactly this case.
    ['   ', false],
    ['\t\n', false],
    [undefined, false],
  ])('treats %o as %s', (value, expected) => {
    expect(isCiMarkerSet(value as string | undefined)).toBe(expected);
  });
});

describe('isCiEnvironment', () => {
  it('is false when nothing is set', () => {
    expect(isCiEnvironment({})).toBe(false);
  });

  it('is false for an empty CI, which means not-set rather than CI', () => {
    expect(isCiEnvironment({ CI: '' })).toBe(false);
  });

  it('is false for a whitespace-only CI, which is as unset-looking as an empty one', () => {
    expect(isCiEnvironment({ CI: '   ' })).toBe(false);
  });

  it.each([['true'], ['TRUE'], ['1'], ['yes']])('is true for CI=%s', (value) => {
    expect(isCiEnvironment({ CI: value })).toBe(true);
  });

  it.each([['0'], ['false'], ['False']])('is false for the CI=%s opt-out', (value) => {
    expect(isCiEnvironment({ CI: value })).toBe(false);
  });

  it('is true for a GITHUB_ACTIONS marker alone', () => {
    expect(isCiEnvironment({ GITHUB_ACTIONS: 'true' })).toBe(true);
  });

  it('is true for a GITLAB_CI marker alone', () => {
    expect(isCiEnvironment({ GITLAB_CI: 'true' })).toBe(true);
  });

  it('is false for GITHUB_ACTIONS=false — the opt-out applies to vendor markers too', () => {
    expect(isCiEnvironment({ GITHUB_ACTIONS: 'false' })).toBe(false);
  });

  it('lets a vendor marker beat CI=false — a DELIBERATE divergence from ci-info, do not "fix" it', () => {
    // ci-info gates all vendor detection behind `env.CI !== 'false'`, so there
    // CI=false is a global bypass. Ours cancels the generic marker only: an
    // explicit GITHUB_ACTIONS names a real browserless runner rather than a
    // user's intent, so it still wins. Pinned so nobody aligns us with ci-info
    // after reading only the upstream library.
    expect(isCiEnvironment({ CI: 'false', GITHUB_ACTIONS: 'true' })).toBe(true);
  });

  it('defaults to process.env when no env is passed', () => {
    expect(typeof isCiEnvironment()).toBe('boolean');
  });
});
