import { describe, expect, it } from 'vitest';
import { calculateJwkThumbprint, importJWK } from 'jose';
import {
  DbSigner,
  unwrapPrivateJwk,
  unwrapPrivateJwkWithKeyAge,
  wrapPrivateJwk,
} from './db-signer.js';

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

describe('unwrapPrivateJwk dual-key fallback', () => {
  const OLD_KEY = '1'.repeat(64);

  it('opens a JWK sealed under the OLD key when the old key is supplied', async () => {
    const { encryptedPrivateJwk, kid } = await DbSigner.generate(OLD_KEY);

    // Positive control: the row is genuinely unreadable with the current key
    // alone, so the fallback below is doing the work.
    expect(() => unwrapPrivateJwk(encryptedPrivateJwk, KEY)).toThrow();

    const jwk = unwrapPrivateJwk(encryptedPrivateJwk, KEY, OLD_KEY);
    expect(jwk.kty).toBe('EC');
    const reloaded = await DbSigner.fromEncrypted(encryptedPrivateJwk, KEY, OLD_KEY);
    expect(await reloaded.getKid()).toBe(kid);
  });

  it('still opens a JWK sealed under the CURRENT key when an old key is supplied', async () => {
    const { encryptedPrivateJwk } = await DbSigner.generate(KEY);
    expect(unwrapPrivateJwk(encryptedPrivateJwk, KEY, OLD_KEY).kty).toBe('EC');
  });

  it('throws when neither key opens the row', async () => {
    const { encryptedPrivateJwk } = await DbSigner.generate('2'.repeat(64));
    expect(() => unwrapPrivateJwk(encryptedPrivateJwk, KEY, OLD_KEY)).toThrow();
  });

  it('reports which key opened the row so a caller can re-seal it', async () => {
    const sealedOld = await DbSigner.generate(OLD_KEY);
    expect(unwrapPrivateJwkWithKeyAge(sealedOld.encryptedPrivateJwk, KEY, OLD_KEY).usedOldKey).toBe(
      true,
    );
    const sealedCurrent = await DbSigner.generate(KEY);
    expect(
      unwrapPrivateJwkWithKeyAge(sealedCurrent.encryptedPrivateJwk, KEY, OLD_KEY).usedOldKey,
    ).toBe(false);
  });
});
