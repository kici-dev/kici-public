import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { calculateJwkThumbprint, type JWK } from 'jose';
import { LocalDevSigner, KICI_LOCAL_ISSUER } from './local-dev-signer.js';

function freshPrivateJwk(): JWK {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return privateKey.export({ format: 'jwk' }) as JWK;
}

describe('KICI_LOCAL_ISSUER', () => {
  it('is the fixed non-prod sentinel and never the prod issuer', () => {
    expect(KICI_LOCAL_ISSUER).toBe('kici-local');
    expect(KICI_LOCAL_ISSUER).not.toContain('api.kici.dev');
    expect(KICI_LOCAL_ISSUER.startsWith('http')).toBe(false);
  });
});

describe('LocalDevSigner', () => {
  it('rejects a non-EC / non-private JWK', async () => {
    await expect(LocalDevSigner.fromPrivateJwk({ kty: 'RSA' } as JWK)).rejects.toThrow(/EC P-256/);
    const pubOnly = { ...freshPrivateJwk() };
    delete pubOnly.d;
    await expect(LocalDevSigner.fromPrivateJwk(pubOnly)).rejects.toThrow(/EC P-256/);
  });

  it('exposes a public JWK without the private component and a stable RFC7638 kid', async () => {
    const jwk = freshPrivateJwk();
    const signer = await LocalDevSigner.fromPrivateJwk(jwk);
    const pub = signer.getPublicJwk();
    expect(pub.kty).toBe('EC');
    expect(pub.crv).toBe('P-256');
    expect(pub.d).toBeUndefined(); // the private scalar never leaves the process
    // kid equals the RFC7638 thumbprint over the public members.
    const expectedKid = await calculateJwkThumbprint(
      { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
      'sha256',
    );
    expect(signer.getKid()).toBe(expectedKid);
    expect(pub.kid).toBe(expectedKid);
  });

  it('produces a JOSE-raw r||s signature the public key verifies', async () => {
    const jwk = freshPrivateJwk();
    const signer = await LocalDevSigner.fromPrivateJwk(jwk);
    const data = new TextEncoder().encode('provenance-payload');
    const sig = await signer.sign(data);
    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(64); // P-256 raw r||s

    // Verify against the public JWK using Web Crypto ECDSA.
    const pub = signer.getPublicJwk();
    const pubKey = await crypto.subtle.importKey(
      'jwk',
      { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y } as JsonWebKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pubKey,
      sig as unknown as BufferSource,
      data as unknown as BufferSource,
    );
    expect(ok).toBe(true);
  });
});
