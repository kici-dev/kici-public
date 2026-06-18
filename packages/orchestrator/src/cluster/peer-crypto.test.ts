import { describe, expect, it } from 'vitest';

import {
  generateEcdhKeyPair,
  deriveSessionKey,
  encryptMessage,
  decryptMessage,
} from './peer-crypto.js';

describe('generateEcdhKeyPair', () => {
  it('returns object with publicKey Buffer (DER SPKI) and privateKey KeyObject', () => {
    const pair = generateEcdhKeyPair();
    expect(pair.publicKey).toBeInstanceOf(Buffer);
    expect(pair.publicKey.length).toBeGreaterThan(0);
    expect(pair.privateKey.type).toBe('private');
    expect(pair.privateKey.asymmetricKeyType).toBe('x25519');
  });

  it('two generated key pairs produce different public keys', () => {
    const pair1 = generateEcdhKeyPair();
    const pair2 = generateEcdhKeyPair();
    expect(pair1.publicKey.equals(pair2.publicKey)).toBe(false);
  });
});

describe('deriveSessionKey', () => {
  it('produces a 32-byte Buffer from two complementary key pairs and a nonce', () => {
    const pairA = generateEcdhKeyPair();
    const pairB = generateEcdhKeyPair();
    const nonce = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');

    const sessionKey = deriveSessionKey(pairA.privateKey, pairB.publicKey, nonce);
    expect(sessionKey).toBeInstanceOf(Buffer);
    expect(sessionKey.length).toBe(32);
  });

  it('is symmetric — A.priv + B.pub + nonce === B.priv + A.pub + nonce', () => {
    const pairA = generateEcdhKeyPair();
    const pairB = generateEcdhKeyPair();
    const nonce = Buffer.from('deadbeefdeadbeefdeadbeefdeadbeef', 'hex');

    const keyAB = deriveSessionKey(pairA.privateKey, pairB.publicKey, nonce);
    const keyBA = deriveSessionKey(pairB.privateKey, pairA.publicKey, nonce);
    expect(keyAB.equals(keyBA)).toBe(true);
  });

  it('different nonces produce different session keys', () => {
    const pairA = generateEcdhKeyPair();
    const pairB = generateEcdhKeyPair();
    const nonce1 = Buffer.from('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', 'hex');
    const nonce2 = Buffer.from('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2', 'hex');

    const key1 = deriveSessionKey(pairA.privateKey, pairB.publicKey, nonce1);
    const key2 = deriveSessionKey(pairA.privateKey, pairB.publicKey, nonce2);
    expect(key1.equals(key2)).toBe(false);
  });
});

describe('encryptMessage / decryptMessage', () => {
  it('roundtrip preserves plaintext', () => {
    const pairA = generateEcdhKeyPair();
    const pairB = generateEcdhKeyPair();
    const nonce = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
    const sessionKey = deriveSessionKey(pairA.privateKey, pairB.publicKey, nonce);

    const plaintext = 'Hello, secure channel!';
    const encrypted = encryptMessage(plaintext, sessionKey);
    const decrypted = decryptMessage(encrypted, sessionKey);
    expect(decrypted).toBe(plaintext);
  });

  it('decryptMessage with wrong session key throws', () => {
    const pairA = generateEcdhKeyPair();
    const pairB = generateEcdhKeyPair();
    const pairC = generateEcdhKeyPair();
    const nonce = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');

    const rightKey = deriveSessionKey(pairA.privateKey, pairB.publicKey, nonce);
    const wrongKey = deriveSessionKey(pairA.privateKey, pairC.publicKey, nonce);

    const encrypted = encryptMessage('secret data', rightKey);
    expect(() => decryptMessage(encrypted, wrongKey)).toThrow();
  });

  it('decryptMessage with tampered ciphertext throws (GCM auth tag check)', () => {
    const pairA = generateEcdhKeyPair();
    const pairB = generateEcdhKeyPair();
    const nonce = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
    const sessionKey = deriveSessionKey(pairA.privateKey, pairB.publicKey, nonce);

    const encrypted = encryptMessage('secret data', sessionKey);
    // Tamper with the ciphertext (flip a byte in the middle of the base64)
    const packed = Buffer.from(encrypted, 'base64');
    packed[packed.length - 1] ^= 0xff; // flip last byte
    const tampered = packed.toString('base64');

    expect(() => decryptMessage(tampered, sessionKey)).toThrow();
  });
});
