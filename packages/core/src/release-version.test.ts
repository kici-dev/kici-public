import { describe, expect, it } from 'vitest';
import { compareReleaseVersions } from './release-version.js';

describe('compareReleaseVersions', () => {
  it('orders numerically, not lexically', () => {
    expect(compareReleaseVersions('0.1.9', '0.1.10')).toBeLessThan(0);
    expect(compareReleaseVersions('0.7.0', '0.6.1')).toBeGreaterThan(0);
    expect(compareReleaseVersions('0.8.0', '0.8.0')).toBe(0);
  });
  it('orders a prerelease below its own base and above the previous base', () => {
    expect(compareReleaseVersions('0.8.0-9700', '0.8.0')).toBeLessThan(0);
    expect(compareReleaseVersions('0.8.0-9700', '0.7.0')).toBeGreaterThan(0);
  });
  // fails-when: all-digit prerelease identifiers are compared as strings ('9700' > '10000')
  it('orders all-digit prerelease identifiers numerically', () => {
    expect(compareReleaseVersions('0.8.0-9700', '0.8.0-10000')).toBeLessThan(0);
  });
  // fails-when: the prerelease group accepts any character — a spec built from such a
  // version would reach the npm shell payload carrying `$(…)`
  it('rejects a prerelease outside the semver identifier charset', () => {
    expect(() => compareReleaseVersions('0.8.0-$(x)', '0.8.0')).toThrow(/not a version/);
    expect(compareReleaseVersions('0.8.0-rc.1', '0.8.0')).toBeLessThan(0);
  });
});
