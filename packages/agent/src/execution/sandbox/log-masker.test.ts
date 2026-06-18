import { describe, it, expect } from 'vitest';
import { LogMasker } from './log-masker.js';

describe('LogMasker', () => {
  it('masks a single secret value', () => {
    const masker = new LogMasker();
    masker.registerSecrets({ TOKEN: 'abc123' });

    expect(masker.mask('Token is abc123')).toBe('Token is ***');
  });

  it('masks multiple secrets in one line', () => {
    const masker = new LogMasker();
    masker.registerSecrets({ TOKEN: 'abc123', PASSWORD: 'mypass' });

    expect(masker.mask('auth: abc123, pass: mypass')).toBe('auth: ***, pass: ***');
  });

  it('does NOT mask values shorter than 3 characters', () => {
    const masker = new LogMasker();
    masker.registerSecrets({ SHORT: 'ab', TINY: 'x' });

    expect(masker.mask('ab and x should remain')).toBe('ab and x should remain');
    expect(masker.hasSecrets()).toBe(false);
  });

  it('handles regex special characters in secret values', () => {
    const masker = new LogMasker();
    masker.registerSecrets({ SPECIAL: '$ecret.val+ue' });

    expect(masker.mask('value is $ecret.val+ue here')).toBe('value is *** here');
  });

  it('returns line unchanged when no secrets are registered', () => {
    const masker = new LogMasker();

    expect(masker.mask('nothing to mask here')).toBe('nothing to mask here');
    expect(masker.hasSecrets()).toBe(false);
  });

  it('masks longer values before shorter ones (prevents partial masks)', () => {
    const masker = new LogMasker();
    // 'abc' is a substring of 'abcdef'. The longer value should be masked first.
    masker.registerSecrets({ LONG: 'abcdef', SHORT: 'abc' });

    // 'abcdef' should be fully masked, not partially masked to '***def'
    expect(masker.mask('secret: abcdef')).toBe('secret: ***');
  });

  it('returns empty string unchanged', () => {
    const masker = new LogMasker();
    masker.registerSecrets({ TOKEN: 'abc123' });

    expect(masker.mask('')).toBe('');
  });

  it('is idempotent (masking twice gives same result)', () => {
    const masker = new LogMasker();
    masker.registerSecrets({ TOKEN: 'abc123' });

    const line = 'Token is abc123 here';
    const masked1 = masker.mask(line);
    const masked2 = masker.mask(line);

    expect(masked1).toBe(masked2);
    expect(masked1).toBe('Token is *** here');
  });

  it('masks multiple occurrences of the same secret', () => {
    const masker = new LogMasker();
    masker.registerSecrets({ TOKEN: 'secret' });

    expect(masker.mask('secret and secret again')).toBe('*** and *** again');
  });

  it('deduplicates identical secret values', () => {
    const masker = new LogMasker();
    // Two keys with the same value should not cause issues
    masker.registerSecrets({ KEY1: 'sameval', KEY2: 'sameval' });

    expect(masker.mask('value: sameval')).toBe('value: ***');
    expect(masker.hasSecrets()).toBe(true);
  });

  it('hasSecrets returns true when maskable secrets exist', () => {
    const masker = new LogMasker();
    masker.registerSecrets({ TOKEN: 'abc123' });

    expect(masker.hasSecrets()).toBe(true);
  });

  it('hasSecrets returns false with only short secrets', () => {
    const masker = new LogMasker();
    masker.registerSecrets({ A: 'ab', B: 'cd' });

    expect(masker.hasSecrets()).toBe(false);
  });

  it('handles exactly 3 character secrets (boundary)', () => {
    const masker = new LogMasker();
    masker.registerSecrets({ EXACT: 'abc' });

    expect(masker.mask('value: abc')).toBe('value: ***');
    expect(masker.hasSecrets()).toBe(true);
  });

  describe('base64 variant masking', () => {
    it('masks base64-encoded variant of a secret', () => {
      const masker = new LogMasker();
      masker.registerSecrets({ TOKEN: 'my-secret' });

      // Buffer.from('my-secret').toString('base64') === 'bXktc2VjcmV0'
      expect(masker.mask('header: Basic bXktc2VjcmV0')).toBe('header: Basic ***');
    });

    it('masks both raw and base64 in the same line', () => {
      const masker = new LogMasker();
      masker.registerSecrets({ TOKEN: 'abc123' });

      // Buffer.from('abc123').toString('base64') === 'YWJjMTIz'
      expect(masker.mask('raw: abc123, encoded: YWJjMTIz')).toBe('raw: ***, encoded: ***');
    });

    it('does not add base64 variant for short secrets', () => {
      const masker = new LogMasker();
      masker.registerSecrets({ SHORT: 'ab' });

      // 'ab' is < 3 chars, so it's skipped entirely (no raw, no base64)
      expect(masker.hasSecrets()).toBe(false);
      // Buffer.from('ab').toString('base64') === 'YWI=' -- should NOT be masked
      expect(masker.mask('encoded: YWI=')).toBe('encoded: YWI=');
    });

    it('deduplicates base64 variants across secrets', () => {
      const masker = new LogMasker();
      // Two secrets with the same value produce the same base64 -- no regex error
      masker.registerSecrets({ KEY1: 'sameval', KEY2: 'sameval' });

      const b64 = Buffer.from('sameval').toString('base64');
      expect(masker.mask(`raw: sameval, encoded: ${b64}`)).toBe('raw: ***, encoded: ***');
    });

    it('masks base64 variant containing regex special chars (+ character)', () => {
      const masker = new LogMasker();
      // Buffer.from('my>secret').toString('base64') === 'bXk+c2VjcmV0' (contains +)
      masker.registerSecrets({ TOKEN: 'my>secret' });

      expect(masker.mask('encoded: bXk+c2VjcmV0')).toBe('encoded: ***');
      // Raw value also masked (contains > which is not regex-special, but verifies both work)
      expect(masker.mask('raw: my>secret')).toBe('raw: ***');
    });

    it('masks base64 variant in real-world token pattern', () => {
      const masker = new LogMasker();
      masker.registerSecrets({ CLONE_TOKEN: 'ghp_abc123xyz' });

      // Raw token is masked
      expect(masker.mask('Authorization: token ghp_abc123xyz')).toBe('Authorization: token ***');

      // Base64 of the token value itself is also masked
      // Buffer.from('ghp_abc123xyz').toString('base64') === 'Z2hwX2FiYzEyM3h5eg=='
      expect(masker.mask('Encoded token: Z2hwX2FiYzEyM3h5eg==')).toBe('Encoded token: ***');
    });
  });
});
