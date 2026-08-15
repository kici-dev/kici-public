import { describe, expect, it } from 'vitest';
import { agentVersionAtLeast, parseVersionBase } from './agent-version.js';

describe('parseVersionBase', () => {
  it('parses a release triple', () => {
    expect(parseVersionBase('1.2.3')).toEqual([1, 2, 3]);
  });

  it('drops a prerelease suffix', () => {
    expect(parseVersionBase('0.5.0-9159')).toEqual([0, 5, 0]);
  });

  it('rejects a partial or non-numeric version', () => {
    expect(parseVersionBase('0.5')).toBeNull();
    expect(parseVersionBase('0.5.0.1')).toBeNull();
    expect(parseVersionBase('v0.5.0')).toBeNull();
    expect(parseVersionBase('latest')).toBeNull();
    // `Number('')` is 0 and `Number(' 1')` is 1, so a digits-only test — not a
    // `Number.isNaN` test on the raw part — is what rejects these.
    expect(parseVersionBase('0..0')).toBeNull();
    expect(parseVersionBase('0. 5.0')).toBeNull();
  });
});

describe('agentVersionAtLeast', () => {
  it('accepts the minimum itself and anything above it', () => {
    expect(agentVersionAtLeast('0.5.0', '0.5.0')).toBe(true);
    expect(agentVersionAtLeast('0.5.1', '0.5.0')).toBe(true);
    expect(agentVersionAtLeast('0.6.0', '0.5.0')).toBe(true);
    expect(agentVersionAtLeast('1.0.0', '0.5.0')).toBe(true);
  });

  it('rejects anything below the minimum', () => {
    expect(agentVersionAtLeast('0.4.9', '0.5.0')).toBe(false);
    expect(agentVersionAtLeast('0.4.0', '0.5.0')).toBe(false);
    expect(agentVersionAtLeast('0.0.1', '0.5.0')).toBe(false);
  });

  it('accepts a prerelease of the minimum', () => {
    // The suffixes in play are dev-registry build counters, not release
    // candidates: strict semver would order `0.5.0-9159` below `0.5.0` and read
    // every staging agent as too old for a feature it in fact carries.
    expect(agentVersionAtLeast('0.5.0-9159', '0.5.0')).toBe(true);
  });

  it('reports an unknown version as not proven', () => {
    expect(agentVersionAtLeast(null, '0.5.0')).toBe(false);
    expect(agentVersionAtLeast(undefined, '0.5.0')).toBe(false);
    expect(agentVersionAtLeast('', '0.5.0')).toBe(false);
    expect(agentVersionAtLeast('nightly', '0.5.0')).toBe(false);
  });

  it('reports false rather than throwing on an unparseable minimum', () => {
    expect(agentVersionAtLeast('9.9.9', 'not-a-version')).toBe(false);
  });
});
