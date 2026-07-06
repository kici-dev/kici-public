import { describe, expect, it } from 'vitest';
import { AttestationOrigin } from './attestation-origin.js';

describe('AttestationOrigin', () => {
  it('accepts the three mint-timing values', () => {
    expect(AttestationOrigin.parse('live')).toBe('live');
    expect(AttestationOrigin.parse('deferred')).toBe('deferred');
    expect(AttestationOrigin.parse('offline-backfill')).toBe('offline-backfill');
  });
  it('rejects unknown values', () => {
    expect(AttestationOrigin.safeParse('triggered').success).toBe(false);
  });
  it('exposes enum accessors', () => {
    expect(AttestationOrigin.enum.deferred).toBe('deferred');
    expect(AttestationOrigin.enum['offline-backfill']).toBe('offline-backfill');
  });
});
