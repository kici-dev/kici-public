/**
 * Join protocol v2: the key schedule, transcripts, proofs and sealed bundle.
 *
 * The joiner proves it holds the join token, and the existing orchestrator proves the
 * same back, without either side sending the token secret. Both key from
 * H = SHA-256(secret), the value `join_tokens.token_hash` stores. The bundle is sealed
 * under a key that mixes an ephemeral X25519 agreement with a token-derived binding
 * key, so a relay that records every frame can neither open nor forge it.
 *
 * Key schedule (HKDF-SHA256, salt "kici-join-v2"):
 * - requestKey = HKDF(H, info "joiner-proof"), responseKey = HKDF(H, info "server-proof"),
 *   bindingKey = HKDF(H, info "bundle-binding")
 * - T1 = SHA-256("kici-join-v2/request" || lp(routing) || lp(E_j) || lp(n_j))
 * - T2 = SHA-256(T1 || lp(E_s) || lp(n_s))
 * - joinerProof = HMAC(requestKey, T1), serverProof = HMAC(responseKey, T2)
 * - bundleKey = HKDF(ikm X25519(e_s, E_j), salt bindingKey, info "kici-join-v2/bundle" || T2)
 * - encryptedBundle = AES-256-GCM(bundleKey, aad T2), packed IV || tag || ciphertext
 *
 * lp(x) is a 4-byte big-endian length, then x.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';

import { generateEcdhKeyPair, type EcdhKeyPair } from './peer-crypto.js';

export const JOIN_PROTOCOL_V2 = 2 as const;
export const SERVER_PROOF_MISMATCH_MESSAGE =
  'The join response did not come from an orchestrator that holds this token';

const HKDF_SALT = Buffer.from('kici-join-v2');
const REQUEST_LABEL = Buffer.from('kici-join-v2/request');
const BUNDLE_INFO_PREFIX = Buffer.from('kici-join-v2/bundle');
const KEY_BYTES = 32;
const NONCE_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEX_PROOF = /^[0-9a-f]{64}$/;

export interface JoinKeys {
  requestKey: Buffer;
  responseKey: Buffer;
  bindingKey: Buffer;
}

/** Derive the proof and binding keys from H = SHA-256(secret), as 32 raw bytes. */
export function deriveJoinKeys(tokenHash: Buffer): JoinKeys {
  if (tokenHash.length !== KEY_BYTES) throw new Error('Join key root must be 32 bytes');
  const expand = (info: string) =>
    Buffer.from(hkdfSync('sha256', tokenHash, HKDF_SALT, Buffer.from(info), KEY_BYTES));
  return {
    requestKey: expand('joiner-proof'),
    responseKey: expand('server-proof'),
    bindingKey: expand('bundle-binding'),
  };
}

/** 4-byte big-endian length, then the bytes. */
function lp(value: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}

export function requestTranscript(
  routingB64: string,
  joinerPublicKey: Buffer,
  joinerNonce: Buffer,
): Buffer {
  return createHash('sha256')
    .update(REQUEST_LABEL)
    .update(lp(Buffer.from(routingB64, 'utf-8')))
    .update(lp(joinerPublicKey))
    .update(lp(joinerNonce))
    .digest();
}

export function responseTranscript(
  requestT: Buffer,
  serverPublicKey: Buffer,
  serverNonce: Buffer,
): Buffer {
  return createHash('sha256')
    .update(requestT)
    .update(lp(serverPublicKey))
    .update(lp(serverNonce))
    .digest();
}

const hmacHex = (key: Buffer, data: Buffer): string =>
  createHmac('sha256', key).update(data).digest('hex');

/** Constant-time compare of two 32-byte hex proofs; any other shape is a mismatch. */
function proofMatches(expectedHex: string, presentedHex: string): boolean {
  if (!HEX_PROOF.test(presentedHex)) return false;
  return timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(presentedHex, 'hex'));
}

export const computeJoinerProof = (keys: JoinKeys, t1: Buffer): string =>
  hmacHex(keys.requestKey, t1);
export const verifyJoinerProof = (keys: JoinKeys, t1: Buffer, presented: string): boolean =>
  proofMatches(computeJoinerProof(keys, t1), presented);
export const computeServerProof = (keys: JoinKeys, t2: Buffer): string =>
  hmacHex(keys.responseKey, t2);
export const verifyServerProof = (keys: JoinKeys, t2: Buffer, presented: string): boolean =>
  proofMatches(computeServerProof(keys, t2), presented);

/** Load a DER SPKI public key, refusing anything but X25519. */
export function loadX25519PublicKey(der: Buffer): KeyObject {
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'x25519') throw new Error('Join public key is not an X25519 key');
  return key;
}

/** A low-order peer key yields an all-zero agreement, which carries no secret. */
export function assertNonZeroSharedSecret(shared: Buffer): void {
  if (shared.length === 0 || shared.every((b) => b === 0)) {
    throw new Error('Join key agreement produced an all-zero shared secret');
  }
}

export function agreeSharedSecret(privateKey: KeyObject, peerPublicKeyDer: Buffer): Buffer {
  const shared = diffieHellman({ privateKey, publicKey: loadX25519PublicKey(peerPublicKeyDer) });
  assertNonZeroSharedSecret(shared);
  return shared;
}

export function deriveBundleKey(shared: Buffer, bindingKey: Buffer, responseT: Buffer): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      shared,
      bindingKey,
      Buffer.concat([BUNDLE_INFO_PREFIX, responseT]),
      KEY_BYTES,
    ),
  );
}

/** AES-256-GCM with a random 12-byte IV; packed IV || tag || ciphertext. */
export function sealBundle(plaintext: string, key: Buffer, aad: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function openBundle(sealed: Buffer, key: Buffer, aad: Buffer): string {
  if (sealed.length < IV_BYTES + TAG_BYTES) throw new Error('Sealed join bundle is too short');
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, IV_BYTES), {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([
    decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]).toString('utf-8');
}

export interface JoinRequestV2Fields {
  joinProtocol: typeof JOIN_PROTOCOL_V2;
  routing: string;
  joinerPublicKey: string;
  joinerNonce: string;
  joinerProof: string;
}

/** What the joiner keeps between its request and the response. Never leaves the host. */
export interface JoinerState {
  keys: JoinKeys;
  requestT: Buffer;
  ephemeral: EcdhKeyPair;
}

/** Joiner: build the request fields from the token's routing part and H. */
export function createJoinRequest(input: { routingB64: string; tokenHash: Buffer }): {
  fields: JoinRequestV2Fields;
  state: JoinerState;
} {
  const keys = deriveJoinKeys(input.tokenHash);
  const ephemeral = generateEcdhKeyPair();
  const nonce = randomBytes(NONCE_BYTES);
  const requestT = requestTranscript(input.routingB64, ephemeral.publicKey, nonce);
  return {
    fields: {
      joinProtocol: JOIN_PROTOCOL_V2,
      routing: input.routingB64,
      joinerPublicKey: ephemeral.publicKey.toString('base64'),
      joinerNonce: nonce.toString('base64'),
      joinerProof: computeJoinerProof(keys, requestT),
    },
    state: { keys, requestT, ephemeral },
  };
}

export interface SealedJoinResponse {
  joinProtocol: typeof JOIN_PROTOCOL_V2;
  serverPublicKey: string;
  serverNonce: string;
  serverProof: string;
  encryptedBundle: string;
}

/** Existing orchestrator: seal the bundle to the joiner's one-time key, with a fresh key of its own. */
export function sealJoinResponse(input: {
  keys: JoinKeys;
  requestT: Buffer;
  joinerPublicKey: Buffer;
  bundle: object;
}): SealedJoinResponse {
  const ephemeral = generateEcdhKeyPair();
  const nonce = randomBytes(NONCE_BYTES);
  const responseT = responseTranscript(input.requestT, ephemeral.publicKey, nonce);
  const shared = agreeSharedSecret(ephemeral.privateKey, input.joinerPublicKey);
  const bundleKey = deriveBundleKey(shared, input.keys.bindingKey, responseT);
  return {
    joinProtocol: JOIN_PROTOCOL_V2,
    serverPublicKey: ephemeral.publicKey.toString('base64'),
    serverNonce: nonce.toString('base64'),
    serverProof: computeServerProof(input.keys, responseT),
    encryptedBundle: sealBundle(JSON.stringify(input.bundle), bundleKey, responseT).toString(
      'base64',
    ),
  };
}

/** Joiner: check the server proof first, then open the bundle. */
export function openJoinResponse(state: JoinerState, response: SealedJoinResponse): unknown {
  const serverPublicKey = Buffer.from(response.serverPublicKey, 'base64');
  const responseT = responseTranscript(
    state.requestT,
    serverPublicKey,
    Buffer.from(response.serverNonce, 'base64'),
  );
  if (!verifyServerProof(state.keys, responseT, response.serverProof)) {
    throw new Error(SERVER_PROOF_MISMATCH_MESSAGE);
  }
  const shared = agreeSharedSecret(state.ephemeral.privateKey, serverPublicKey);
  const bundleKey = deriveBundleKey(shared, state.keys.bindingKey, responseT);
  return JSON.parse(
    openBundle(Buffer.from(response.encryptedBundle, 'base64'), bundleKey, responseT),
  );
}
