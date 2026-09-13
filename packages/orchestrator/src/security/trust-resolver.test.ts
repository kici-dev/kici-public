import { describe, expect, it } from 'vitest';
import { resolveRefTrust } from './trust-resolver.js';

describe('resolveRefTrust', () => {
  it('fork PR resolves untrusted (stored as unknown)', () => {
    const r = resolveRefTrust({ isForkPR: true, contributorUsername: 'alice' });
    expect(r.tier).toBe('unknown');
    expect(r.reason).toContain('Fork');
  });

  it('same-repo ref resolves trusted', () => {
    const r = resolveRefTrust({ isForkPR: false, contributorUsername: 'alice' });
    expect(r.tier).toBe('trusted');
  });

  it('carries the contributor username through both branches', () => {
    expect(
      resolveRefTrust({ isForkPR: true, contributorUsername: 'bob' }).contributorUsername,
    ).toBe('bob');
    expect(
      resolveRefTrust({ isForkPR: false, contributorUsername: 'bob' }).contributorUsername,
    ).toBe('bob');
  });

  it('never produces the legacy known tier', () => {
    for (const isForkPR of [true, false]) {
      expect(resolveRefTrust({ isForkPR, contributorUsername: 'carol' }).tier).not.toBe('known');
    }
  });
});
