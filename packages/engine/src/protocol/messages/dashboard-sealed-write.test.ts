import { describe, it, expect } from 'vitest';
import { dashboardSealedEnvelopeSchema } from './dashboard-sealed-write.js';

describe('dashboardSealedEnvelopeSchema', () => {
  it('accepts a well-formed envelope', () => {
    const ok = dashboardSealedEnvelopeSchema.safeParse({
      keyId: 'kid-abc',
      ephemeralPublicKey: Buffer.from('pub').toString('base64'),
      encrypted: Buffer.from('ct').toString('base64'),
    });
    expect(ok.success).toBe(true);
  });

  it('rejects a missing keyId', () => {
    expect(
      dashboardSealedEnvelopeSchema.safeParse({ ephemeralPublicKey: 'x', encrypted: 'y' }).success,
    ).toBe(false);
  });

  it('rejects empty fields', () => {
    expect(
      dashboardSealedEnvelopeSchema.safeParse({
        keyId: '',
        ephemeralPublicKey: 'x',
        encrypted: 'y',
      }).success,
    ).toBe(false);
  });
});
