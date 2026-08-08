import { describe, expect, it } from 'vitest';
import { calculateJwkThumbprint, importJWK } from 'jose';
import { DbSigner, unwrapPrivateJwk, wrapPrivateJwk } from './db-signer.js';

const KEY = '0'.repeat(64); // 32-byte hex master key

describe('DbSigner', () => {
  it('generates a persistable key that signs verifiably', async () => {
    const { signer, publicJwk, encryptedPrivateJwk, kid } = await DbSigner.generate(KEY);
    expect(kid).toBe(await calculateJwkThumbprint(publicJwk, 'sha256'));
    expect(signer.signerKind).toBe('db');
    expect(signer.keyRef).toBeNull();

    const data = new TextEncoder().encode('hello');
    const sig = await signer.sign(data);
    const pub = (await importJWK(publicJwk, 'ES256')) as CryptoKey;
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pub,
      sig as unknown as BufferSource,
      data as unknown as BufferSource,
    );
    expect(ok).toBe(true);

    // reload from encrypted private material, same kid + still signs
    const reloaded = await DbSigner.fromEncrypted(encryptedPrivateJwk, KEY);
    expect(await reloaded.getKid()).toBe(kid);
    const sig2 = await reloaded.sign(data);
    const ok2 = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pub,
      sig2 as unknown as BufferSource,
      data as unknown as BufferSource,
    );
    expect(ok2).toBe(true);
  });

  it('public JWK never contains the private member d', async () => {
    const { publicJwk } = await DbSigner.generate(KEY);
    expect((publicJwk as Record<string, unknown>).d).toBeUndefined();
  });

  it('wrap/unwrap round-trips the private JWK with a fresh IV each time', async () => {
    const { encryptedPrivateJwk } = await DbSigner.generate(KEY);
    const jwk = unwrapPrivateJwk(encryptedPrivateJwk, KEY);
    expect(jwk.d).toBeTruthy();
    expect(wrapPrivateJwk(jwk, KEY)).not.toEqual(encryptedPrivateJwk); // fresh IV each time
  });

  it('unwrap fails with the wrong master key', async () => {
    const { encryptedPrivateJwk } = await DbSigner.generate(KEY);
    expect(() => unwrapPrivateJwk(encryptedPrivateJwk, '1'.repeat(64))).toThrow();
  });
});
