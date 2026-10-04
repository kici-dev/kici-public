import { createHash, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { generateEcdhKeyPair } from './peer-crypto.js';
import {
  SERVER_PROOF_MISMATCH_MESSAGE,
  agreeSharedSecret,
  assertNonZeroSharedSecret,
  computeJoinerProof,
  computeServerProof,
  createJoinRequest,
  deriveBundleKey,
  deriveJoinKeys,
  loadX25519PublicKey,
  openBundle,
  openJoinResponse,
  requestTranscript,
  responseTranscript,
  sealBundle,
  sealJoinResponse,
  verifyJoinerProof,
  type JoinRequestV2Fields,
  type SealedJoinResponse,
} from './join-protocol-v2.js';

const H = () => createHash('sha256').update(randomBytes(32)).digest();
const ROUTING = Buffer.from(JSON.stringify({ orgId: 'o', routingKey: 'k', expiry: 1 })).toString(
  'base64url',
);
const BUNDLE = { databaseUrl: 'postgres://db/kici', secretKey: 'c'.repeat(64), clusterId: 'cl-1' };

function serverAccepts(h: Buffer, f: JoinRequestV2Fields) {
  const keys = deriveJoinKeys(h);
  const t1 = requestTranscript(
    f.routing,
    Buffer.from(f.joinerPublicKey, 'base64'),
    Buffer.from(f.joinerNonce, 'base64'),
  );
  return { ok: verifyJoinerProof(keys, t1, f.joinerProof), keys, t1 };
}

function sealFor(h: Buffer, fields: JoinRequestV2Fields): SealedJoinResponse {
  const s = serverAccepts(h, fields);
  return sealJoinResponse({
    keys: s.keys,
    requestT: s.t1,
    joinerPublicKey: Buffer.from(fields.joinerPublicKey, 'base64'),
    bundle: BUNDLE,
  });
}

/** The response transcript a relay can recompute from the frames it saw. */
function recordedT2(fields: JoinRequestV2Fields, sealed: SealedJoinResponse): Buffer {
  const t1 = requestTranscript(
    fields.routing,
    Buffer.from(fields.joinerPublicKey, 'base64'),
    Buffer.from(fields.joinerNonce, 'base64'),
  );
  return responseTranscript(
    t1,
    Buffer.from(sealed.serverPublicKey, 'base64'),
    Buffer.from(sealed.serverNonce, 'base64'),
  );
}

describe('join protocol v2', () => {
  // breaks-if-wrong: an untouched exchange opens the bundle.
  it('round-trips: the server accepts the proof and the joiner opens the bundle', () => {
    const h = H();
    const { fields, state } = createJoinRequest({ routingB64: ROUTING, tokenHash: h });
    expect(serverAccepts(h, fields).ok).toBe(true);
    expect(openJoinResponse(state, sealFor(h, fields))).toEqual(BUNDLE);
  });

  it('requires a 32-byte key root', () => {
    expect(() => deriveJoinKeys(randomBytes(31))).toThrow(/32 bytes/);
  });

  // fails-when: T1 omits E_j.
  it('a swapped joiner public key fails the proof', () => {
    const h = H();
    const a = createJoinRequest({ routingB64: ROUTING, tokenHash: h });
    const b = createJoinRequest({ routingB64: ROUTING, tokenHash: h });
    expect(serverAccepts(h, { ...a.fields, joinerPublicKey: b.fields.joinerPublicKey }).ok).toBe(
      false,
    );
  });

  // fails-when: T1 omits the joiner nonce.
  it('a swapped joiner nonce fails the proof', () => {
    const h = H();
    const { fields } = createJoinRequest({ routingB64: ROUTING, tokenHash: h });
    expect(
      serverAccepts(h, { ...fields, joinerNonce: randomBytes(32).toString('base64') }).ok,
    ).toBe(false);
  });

  // fails-when: T1 omits the routing part.
  it('an edited routing part fails the proof', () => {
    const h = H();
    const { fields } = createJoinRequest({ routingB64: ROUTING, tokenHash: h });
    const other = Buffer.from(JSON.stringify({ orgId: 'o', routingKey: 'k', expiry: 2 })).toString(
      'base64url',
    );
    expect(serverAccepts(h, { ...fields, routing: other }).ok).toBe(false);
  });

  it('a different secret with the same routing fails the proof', () => {
    const { fields } = createJoinRequest({ routingB64: ROUTING, tokenHash: H() });
    expect(serverAccepts(H(), fields).ok).toBe(false);
  });

  it('refuses a proof that is not 64 lowercase hex characters', () => {
    const h = H();
    const { fields } = createJoinRequest({ routingB64: ROUTING, tokenHash: h });
    expect(serverAccepts(h, { ...fields, joinerProof: fields.joinerProof.toUpperCase() }).ok).toBe(
      false,
    );
    expect(serverAccepts(h, { ...fields, joinerProof: fields.joinerProof.slice(2) }).ok).toBe(
      false,
    );
  });

  // fails-when: the request and response proofs share an HKDF label.
  it('separates the request and response proof keys', () => {
    const keys = deriveJoinKeys(H());
    const x = randomBytes(32);
    expect(computeJoinerProof(keys, x)).not.toBe(computeServerProof(keys, x));
  });

  // fails-when: the joiner decrypts before checking the server proof.
  it('refuses a response whose bundle opens but whose server proof is forged', () => {
    const h = H();
    const { fields, state } = createJoinRequest({ routingB64: ROUTING, tokenHash: h });
    const sealed = sealFor(h, fields);
    expect(() => openJoinResponse(state, { ...sealed, serverProof: 'a'.repeat(64) })).toThrow(
      SERVER_PROOF_MISMATCH_MESSAGE,
    );
  });

  it('refuses a joiner proof echoed back as the server proof (reflection)', () => {
    const h = H();
    const { fields, state } = createJoinRequest({ routingB64: ROUTING, tokenHash: h });
    const sealed = sealFor(h, fields);
    expect(() => openJoinResponse(state, { ...sealed, serverProof: fields.joinerProof })).toThrow(
      SERVER_PROOF_MISMATCH_MESSAGE,
    );
  });

  // fails-when: T2 omits the server public key, so a relay can substitute its own key.
  it('refuses a response whose server public key was replaced', () => {
    const h = H();
    const { fields, state } = createJoinRequest({ routingB64: ROUTING, tokenHash: h });
    const sealed = sealFor(h, fields);
    const relayKey = generateEcdhKeyPair().publicKey.toString('base64');
    expect(() => openJoinResponse(state, { ...sealed, serverPublicKey: relayKey })).toThrow(
      SERVER_PROOF_MISMATCH_MESSAGE,
    );
  });

  // fails-when: K_bind is not mixed into K_bundle.
  it('a bundle key with the right agreement but another token binding key does not open', () => {
    const a = generateEcdhKeyPair();
    const b = generateEcdhKeyPair();
    const z = agreeSharedSecret(a.privateKey, b.publicKey);
    const t2 = randomBytes(32);
    const sealed = sealBundle('{}', deriveBundleKey(z, deriveJoinKeys(H()).bindingKey, t2), t2);
    expect(() =>
      openBundle(sealed, deriveBundleKey(z, deriveJoinKeys(H()).bindingKey, t2), t2),
    ).toThrow();
  });

  it('the AAD binds the transcript', () => {
    const key = randomBytes(32);
    const sealed = sealBundle('{}', key, Buffer.from('t2'));
    expect(() => openBundle(sealed, key, Buffer.from('other'))).toThrow();
    expect(openBundle(sealed, key, Buffer.from('t2'))).toBe('{}');
  });

  it('a recorder cannot open the bundle with a token-only key; the same opener opens a bundle sealed under one (positive control)', () => {
    const secret = randomBytes(32);
    const h = createHash('sha256').update(secret).digest();
    const v1Key = Buffer.from(
      hkdfSync('sha256', secret, Buffer.from('kici-join-encrypt'), Buffer.from('v1'), 32),
    );
    const { fields } = createJoinRequest({ routingB64: ROUTING, tokenHash: h });
    const sealed = sealFor(h, fields);
    const t2 = recordedT2(fields, sealed);
    const keys = deriveJoinKeys(h);
    for (const key of [v1Key, h, keys.requestKey, keys.responseKey, keys.bindingKey]) {
      expect(() => openBundle(Buffer.from(sealed.encryptedBundle, 'base64'), key, t2)).toThrow();
    }
    const control = sealBundle(JSON.stringify(BUNDLE), v1Key, t2);
    expect(JSON.parse(openBundle(control, v1Key, t2))).toEqual(BUNDLE);
  });

  it('two responses to one request use different server keys (no static or reused key)', () => {
    const h = H();
    const { fields } = createJoinRequest({ routingB64: ROUTING, tokenHash: h });
    expect(sealFor(h, fields).serverPublicKey).not.toBe(sealFor(h, fields).serverPublicKey);
  });

  // fails-when: a low-order joiner key (all-zero u-coordinate) yields a usable bundle key.
  it('refuses an agreement with a low-order public key', () => {
    const lowOrder = Buffer.concat([
      Buffer.from('302a300506032b656e032100', 'hex'),
      Buffer.alloc(32),
    ]);
    expect(loadX25519PublicKey(lowOrder).asymmetricKeyType).toBe('x25519');
    expect(() => agreeSharedSecret(generateEcdhKeyPair().privateKey, lowOrder)).toThrow();
  });

  it('refuses a non-X25519 public key and an all-zero agreement', () => {
    const ed = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' });
    expect(() => loadX25519PublicKey(ed as Buffer)).toThrow(/X25519/);
    expect(() => assertNonZeroSharedSecret(Buffer.alloc(32))).toThrow(/all-zero/);
    expect(() => assertNonZeroSharedSecret(randomBytes(32))).not.toThrow();
  });
});
