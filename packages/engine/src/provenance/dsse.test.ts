import { describe, expect, it } from 'vitest';
import { buildDsseEnvelope, dsseEnvelopeSchema, dssePae } from './dsse.js';

describe('dssePae', () => {
  it('encodes the in-toto PAE exactly', () => {
    const pae = dssePae('application/vnd.in-toto+json', new TextEncoder().encode('{}'));
    expect(new TextDecoder().decode(pae)).toBe('DSSEv1 28 application/vnd.in-toto+json 2 {}');
  });

  it('counts payload bytes, not characters, in the body length', () => {
    // 'é' is two UTF-8 bytes.
    const pae = dssePae('t', new TextEncoder().encode('é'));
    expect(new TextDecoder().decode(pae)).toBe('DSSEv1 1 t 2 é');
  });
});

describe('buildDsseEnvelope', () => {
  it('base64s the payload + signatures', () => {
    const env = buildDsseEnvelope('t', new TextEncoder().encode('hi'), [
      { keyid: 'k', sig: new Uint8Array([1, 2, 3]) },
    ]);
    expect(env.payloadType).toBe('t');
    expect(Buffer.from(env.payload, 'base64').toString()).toBe('hi');
    expect(env.signatures[0]).toEqual({
      keyid: 'k',
      sig: Buffer.from([1, 2, 3]).toString('base64'),
    });
    expect(() => dsseEnvelopeSchema.parse(env)).not.toThrow();
  });

  it('rejects an envelope with zero signatures via the schema', () => {
    expect(
      dsseEnvelopeSchema.safeParse({ payloadType: 't', payload: 'aGk=', signatures: [] }).success,
    ).toBe(false);
  });
});
