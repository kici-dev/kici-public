import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { encryptJson, decryptJson } from './crypto.js';

function ephemeralPair() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: Buffer.from(publicKey.export({ type: 'spki', format: 'der' })),
    privateKey: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' })),
  };
}

describe('encryptJson / decryptJson', () => {
  it('round-trips a JSON value through X25519 + AES-256-GCM', () => {
    const recipient = ephemeralPair();
    const value = { flat: { TOKEN: 'abc' }, contexts: { db: { URL: 'postgres://x' } } };
    const { ciphertextB64, senderPublicKeyB64 } = encryptJson(value, recipient.publicKey);
    const out = decryptJson<typeof value>(
      ciphertextB64,
      Buffer.from(senderPublicKeyB64, 'base64'),
      recipient.privateKey,
    );
    expect(out).toEqual(value);
  });

  it('fails to decrypt with the wrong recipient key', () => {
    const recipient = ephemeralPair();
    const wrong = ephemeralPair();
    const { ciphertextB64, senderPublicKeyB64 } = encryptJson({ a: 1 }, recipient.publicKey);
    expect(() =>
      decryptJson(ciphertextB64, Buffer.from(senderPublicKeyB64, 'base64'), wrong.privateKey),
    ).toThrow();
  });
});
