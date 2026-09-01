import { describe, it, expect } from 'vitest';
import { invalidRepoPatternReason, repoPatternEntrySchema } from './dashboard-global-workflows.js';

describe('invalidRepoPatternReason', () => {
  it('rejects a leading-bang negation', () => {
    expect(invalidRepoPatternReason('!myorg/x')).toMatch(/negation/);
  });

  it('rejects extglob negation', () => {
    expect(invalidRepoPatternReason('!(a|b)/x')).toMatch(/negation/);
  });

  it('rejects the negated character class', () => {
    expect(invalidRepoPatternReason('myorg/[^a]*')).toMatch(/negation/);
  });

  it('accepts the [! character class, which picomatch reads as a literal class', () => {
    // `[!s]` is NOT the POSIX negation here: picomatch reads it as a literal
    // class containing `!` and `s`, so `org/[!s]*` admits exactly the
    // repositories whose name begins with `!` or `s` — the inverse of
    // `org/[^s]*`, and a genuine restriction. Rejecting it would refuse a
    // pattern that grants strictly less than it names while leaving the real
    // inversion open. Do not "fix" this by adding a `[!` arm.
    expect(invalidRepoPatternReason('myorg/[!a]*')).toBeNull();
    expect(invalidRepoPatternReason('myorg/[!secret]')).toBeNull();
  });

  it('rejects a negative lookahead, which picomatch compiles into a real inversion', () => {
    // `(?!myorg/secret)**` matches every repository in every organization
    // except the one it names — a near-universal grant on a list whose
    // purpose is restriction.
    expect(invalidRepoPatternReason('(?!myorg/secret)**')).toMatch(/negation|assertion/);
    expect(invalidRepoPatternReason('myorg/(?!secret)*')).toMatch(/negation|assertion/);
  });

  it('rejects a negative lookbehind', () => {
    expect(invalidRepoPatternReason('**(?<!secret)')).toMatch(/negation|assertion/);
    expect(invalidRepoPatternReason('myorg/**(?<!secret)')).toMatch(/negation|assertion/);
  });

  it('accepts the positive assertions and a plain group, which grant what they name', () => {
    expect(invalidRepoPatternReason('myorg/(?=app)*')).toBeNull();
    expect(invalidRepoPatternReason('myorg/(?<=app)*')).toBeNull();
    expect(invalidRepoPatternReason('myorg/(?:app|api)')).toBeNull();
    expect(invalidRepoPatternReason('myorg/(app|api)')).toBeNull();
  });

  it('rejects an empty or whitespace-only pattern', () => {
    expect(invalidRepoPatternReason('')).toBe('pattern is empty');
    expect(invalidRepoPatternReason('  ')).toBe('pattern is empty');
  });

  it('accepts ordinary globs, including a dot-prefixed repo name', () => {
    expect(invalidRepoPatternReason('myorg/*')).toBeNull();
    expect(invalidRepoPatternReason('**')).toBeNull();
    expect(invalidRepoPatternReason('myorg/.github')).toBeNull();
    expect(invalidRepoPatternReason('myorg/ci-deploy')).toBeNull();
  });

  it('leaves the entry schema itself permissive, so stored rows keep parsing', () => {
    expect(repoPatternEntrySchema.safeParse({ pattern: '!myorg/x' }).success).toBe(true);
  });
});
