import { describe, expect, it } from 'vitest';
import { TRUSTED_STATUSES } from './signing-key-status.js';
import { derToRawEcdsaSignature } from './signer.js';

describe('signer helpers', () => {
  it('excludes revoked from trusted statuses', () => {
    expect(TRUSTED_STATUSES).toEqual(['active', 'retiring', 'retired']);
    expect(TRUSTED_STATUSES).not.toContain('revoked');
  });

  it('pads a short DER integer to 32 bytes per component', () => {
    // minimal DER: SEQ { INT 0x01, INT 0x02 } → raw = 32 bytes r + 32 bytes s
    const der = Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02]);
    const raw = derToRawEcdsaSignature(der, 32);
    expect(raw.length).toBe(64);
    expect(raw[31]).toBe(1);
    expect(raw[63]).toBe(2);
  });
});
