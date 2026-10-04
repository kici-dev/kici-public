import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  refAppKey,
  refClientProof,
  refServerProof,
  refTranscriptHash,
} from '../__test-helpers__/peer-mutual-auth.js';
import {
  computeClientProof,
  computeServerProof,
  decodeProof,
  deriveAppKey,
  generateEcdhKeyPair,
  deriveSessionKey,
  encryptMessage,
  decryptMessage,
  lengthPrefixed,
  peerTranscriptHash,
  proofMatches,
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

function transcriptInput() {
  return {
    serverEphemeralPublicKey: generateEcdhKeyPair().publicKey,
    serverNonce: randomBytes(32),
    authSchemes: ['mutual-v2'],
    clientEphemeralPublicKey: generateEcdhKeyPair().publicKey,
  };
}

describe('mutual-v2 key schedule', () => {
  it('lengthPrefixed separates adjacent fields', () => {
    // fails-when: fields are concatenated without a length header
    expect(lengthPrefixed('ab', 'c').equals(lengthPrefixed('a', 'bc'))).toBe(false);
    expect(lengthPrefixed('ab').subarray(0, 4).readUInt32BE(0)).toBe(2);
  });

  it('the transcript hash matches an independent implementation', () => {
    // breaks-if-wrong: client and server must compute an equal TH from views built separately
    const i = transcriptInput();
    expect(
      peerTranscriptHash(i).equals(
        refTranscriptHash(
          i.serverEphemeralPublicKey,
          i.serverNonce,
          i.authSchemes,
          i.clientEphemeralPublicKey,
        ),
      ),
    ).toBe(true);
  });

  it('the transcript hash changes when any single field changes', () => {
    const base = transcriptInput();
    const th = peerTranscriptHash(base);
    const variants = [
      { ...base, serverEphemeralPublicKey: generateEcdhKeyPair().publicKey },
      { ...base, serverNonce: randomBytes(32) },
      { ...base, authSchemes: ['mutual-v3', 'mutual-v2'] },
      { ...base, clientEphemeralPublicKey: generateEcdhKeyPair().publicKey },
    ];
    for (const v of variants) expect(peerTranscriptHash(v).equals(th)).toBe(false);
  });

  it('a shifted boundary between nonce and scheme list changes the hash', () => {
    const base = transcriptInput();
    const nonce = Buffer.concat([base.serverNonce, Buffer.from('m')]);
    const shifted = { ...base, serverNonce: nonce, authSchemes: ['utual-v2'] };
    expect(peerTranscriptHash(shifted).equals(peerTranscriptHash(base))).toBe(false);
  });

  it('client and server proofs match the independent implementation and differ from each other', () => {
    const psk = randomBytes(32);
    const th = randomBytes(32);
    const clientProof = computeClientProof({
      psk,
      transcriptHash: th,
      mode: 'credential',
      clientInstanceId: 'a',
      role: 'coordinator',
      protocolVersion: 3,
      tokenRouting: '',
    });
    expect(
      clientProof.equals(
        refClientProof({
          psk,
          th,
          mode: 'credential',
          instanceId: 'a',
          role: 'coordinator',
          protocolVersion: 3,
          tokenRouting: '',
        }),
      ),
    ).toBe(true);
    const serverProof = computeServerProof({
      psk,
      transcriptHash: th,
      clientProof,
      serverInstanceId: 'b',
      grantedRole: 'coordinator',
      sessionCredential: null,
    });
    expect(
      serverProof.equals(
        refServerProof({
          psk,
          th,
          clientProof,
          serverInstanceId: 'b',
          grantedRole: 'coordinator',
          sessionCredential: null,
        }),
      ),
    ).toBe(true);
    // fails-when: client and server share a label, so an echoed client proof is a server proof
    expect(serverProof.equals(clientProof)).toBe(false);
  });

  it('every client-proof field changes the proof', () => {
    const base = {
      psk: randomBytes(32),
      transcriptHash: randomBytes(32),
      mode: 'token',
      clientInstanceId: 'a',
      role: 'worker',
      protocolVersion: 3,
      tokenRouting: 'cm91dGluZw',
    };
    const p = computeClientProof(base);
    for (const v of [
      { ...base, psk: randomBytes(32) },
      { ...base, transcriptHash: randomBytes(32) },
      { ...base, mode: 'credential' },
      { ...base, clientInstanceId: 'b' },
      { ...base, role: 'coordinator' },
      { ...base, protocolVersion: 4 },
      { ...base, tokenRouting: 'other' },
    ]) {
      expect(computeClientProof(v).equals(p)).toBe(false);
    }
  });

  it('every server-proof field changes the proof, the session credential included', () => {
    const base = {
      psk: randomBytes(32),
      transcriptHash: randomBytes(32),
      clientProof: randomBytes(32),
      serverInstanceId: 'b',
      grantedRole: 'worker',
      sessionCredential: 'cred-1' as string | null,
    };
    const p = computeServerProof(base);
    for (const v of [
      { ...base, psk: randomBytes(32) },
      { ...base, transcriptHash: randomBytes(32) },
      { ...base, clientProof: randomBytes(32) },
      { ...base, serverInstanceId: 'c' },
      { ...base, grantedRole: 'coordinator' },
      { ...base, sessionCredential: 'cred-2' },
      { ...base, sessionCredential: null },
    ]) {
      expect(computeServerProof(v).equals(p)).toBe(false);
    }
  });

  it('K_app depends on the PSK, differs from K_hs and matches the independent implementation', () => {
    const handshakeKey = randomBytes(32);
    const args = {
      handshakeKey,
      psk: randomBytes(32),
      transcriptHash: randomBytes(32),
      clientProof: randomBytes(32),
      serverProof: randomBytes(32),
    };
    const appKey = deriveAppKey(args);
    expect(appKey).toHaveLength(32);
    expect(appKey.equals(handshakeKey)).toBe(false);
    // fails-when: K_app is derived without the PSK
    expect(deriveAppKey({ ...args, psk: randomBytes(32) }).equals(appKey)).toBe(false);
    expect(
      appKey.equals(
        refAppKey({
          handshakeKey,
          psk: args.psk,
          th: args.transcriptHash,
          clientProof: args.clientProof,
          serverProof: args.serverProof,
        }),
      ),
    ).toBe(true);
  });

  it('decodeProof accepts exactly 64 hex characters', () => {
    expect(decodeProof('ab'.repeat(32))).toHaveLength(32);
    expect(decodeProof('ab'.repeat(31))).toBeNull();
    expect(decodeProof('ab'.repeat(33))).toBeNull();
    expect(decodeProof('zz'.repeat(32))).toBeNull();
    expect(decodeProof('')).toBeNull();
  });

  it('proofMatches refuses a length mismatch without throwing', () => {
    const p = randomBytes(32);
    expect(proofMatches(p, Buffer.from(p))).toBe(true);
    expect(proofMatches(p, p.subarray(0, 31))).toBe(false);
    expect(proofMatches(p, randomBytes(32))).toBe(false);
  });
});
