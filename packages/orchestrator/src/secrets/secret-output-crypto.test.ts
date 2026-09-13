/**
 * Tests for the `run_secret_outputs` seal / unseal helpers, including the
 * rotation grace window's old-key fallback.
 */
import { describe, expect, it } from 'vitest';
import { deriveKey } from '@kici-dev/shared';
import { secretOutputAad, sealSecretOutput, unsealSecretOutput } from './secret-output-crypto.js';

const CURRENT = deriveKey('0'.repeat(64));
const OLD = deriveKey('1'.repeat(64));
const OTHER = deriveKey('2'.repeat(64));
const RUN = 'run-abc';

describe('secret-output crypto', () => {
  it('binds the ciphertext to its run via the AAD', () => {
    expect(secretOutputAad(RUN)).toBe(`secret-output:${RUN}`);
    const sealed = sealSecretOutput('shh', CURRENT, RUN);
    expect(() => unsealSecretOutput(sealed.data, 'run-other', { current: CURRENT })).toThrow();
  });

  it('unseals a value sealed under the OLD key when the old key is supplied', () => {
    const sealed = sealSecretOutput('shh', OLD, RUN);

    // Positive control: unreadable with the current key alone, so the fallback
    // below is what makes the read succeed.
    expect(() => unsealSecretOutput(sealed.data, RUN, { current: CURRENT })).toThrow();

    expect(unsealSecretOutput(sealed.data, RUN, { current: CURRENT, old: OLD })).toBe('shh');
  });

  it('still unseals a value sealed under the CURRENT key', () => {
    const sealed = sealSecretOutput('shh', CURRENT, RUN);
    expect(unsealSecretOutput(sealed.data, RUN, { current: CURRENT, old: OLD })).toBe('shh');
  });

  it('throws when neither key opens it', () => {
    const sealed = sealSecretOutput('shh', OTHER, RUN);
    expect(() => unsealSecretOutput(sealed.data, RUN, { current: CURRENT, old: OLD })).toThrow();
  });
});
