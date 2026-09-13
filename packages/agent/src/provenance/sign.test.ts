import { describe, expect, it } from 'vitest';
import { importJWK } from 'jose';
import { dssePae } from '@kici-dev/engine/provenance/dsse';
import { signStatementDsse } from './sign.js';

describe('signStatementDsse', () => {
  it('produces a DSSE envelope whose signature verifies with the ephemeral public key', async () => {
    const statementBytes = new TextEncoder().encode(JSON.stringify({ hello: 'world' }));
    const { envelope, publicJwk } = await signStatementDsse(
      'application/vnd.in-toto+json',
      statementBytes,
    );

    expect(envelope.signatures).toHaveLength(1);
    expect(envelope.signatures[0].keyid).toBe(publicJwk.kid);
    expect(publicJwk.kty).toBe('EC');
    expect(publicJwk.crv).toBe('P-256');

    // Verify the raw ECDSA signature over the PAE with the ephemeral public key.
    const key = (await importJWK(publicJwk, 'ES256')) as CryptoKey;
    const pae = dssePae('application/vnd.in-toto+json', statementBytes);
    const sig = Buffer.from(envelope.signatures[0].sig, 'base64');
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, pae);
    expect(ok).toBe(true);
  });

  it('produces a distinct key on each call (ephemeral)', async () => {
    const bytes = new TextEncoder().encode('x');
    const a = await signStatementDsse('t', bytes);
    const b = await signStatementDsse('t', bytes);
    expect(a.publicJwk.kid).not.toBe(b.publicJwk.kid);
  });
});
