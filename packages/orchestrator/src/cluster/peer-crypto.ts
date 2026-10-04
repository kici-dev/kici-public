/**
 * ECDH key exchange, mutual-v2 authentication and session encryption for
 * peer-to-peer channels.
 *
 * Uses X25519 for key agreement and AES-256-GCM for message encryption.
 * The handshake key (K_hs) is derived via HKDF-SHA256 from the ECDH shared
 * secret and the server nonce; it protects the authentication exchange only.
 *
 * mutual-v2: both sides hash the handshake transcript (TH: both ephemeral keys,
 * the nonce and the advertised schemes). The client proves the shared key (PSK:
 * sha256 of the peer credential, or the join token hash) with an HMAC over TH,
 * and the server answers with its own HMAC over TH and the client proof. Every
 * frame after acceptance uses the application key (K_app), derived from K_hs
 * and the PSK, so a side that skipped the proof check cannot read or write them.
 * Every field is length-prefixed, so field boundaries are unambiguous.
 *
 * Wire format for encrypted messages (base64 encoded):
 *   IV (12 bytes) || AuthTag (16 bytes) || Ciphertext
 */
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  diffieHellman,
  createPublicKey,
  hkdfSync,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';

/** HKDF info string binding derived keys to this protocol version. */
const HKDF_INFO = 'kici-peer-v1';

/** IV length for AES-256-GCM. */
const IV_LEN = 12;

/** Authentication tag length for AES-256-GCM. */
const TAG_LEN = 16;

/**
 * An X25519 key pair for ECDH key exchange.
 * The public key is DER SPKI-encoded for wire transport.
 */
export interface EcdhKeyPair {
  /** DER SPKI-encoded X25519 public key. */
  publicKey: Buffer;
  /** X25519 private key object (not exported to wire). */
  privateKey: KeyObject;
}

/**
 * Generate a new X25519 key pair for ECDH key exchange.
 *
 * @returns Key pair with DER SPKI public key and KeyObject private key
 */
export function generateEcdhKeyPair(): EcdhKeyPair {
  const pair = generateKeyPairSync('x25519');
  const publicKeyDer = pair.publicKey.export({ type: 'spki', format: 'der' });
  return { publicKey: publicKeyDer as Buffer, privateKey: pair.privateKey };
}

/**
 * Derive a 32-byte AES-256 session key from an ECDH key exchange.
 *
 * Performs X25519 Diffie-Hellman, then derives the session key via
 * HKDF-SHA256 with the provided nonce as salt.
 *
 * @param localPrivateKey - This node's X25519 private key
 * @param remotePubKeyDer - Remote node's DER SPKI-encoded X25519 public key
 * @param nonce - Random nonce (used as HKDF salt for per-session uniqueness)
 * @returns 32-byte session key suitable for AES-256-GCM
 */
export function deriveSessionKey(
  localPrivateKey: KeyObject,
  remotePubKeyDer: Buffer,
  nonce: Buffer,
): Buffer {
  const remotePublicKey = createPublicKey({
    key: remotePubKeyDer,
    format: 'der',
    type: 'spki',
  });
  const shared = diffieHellman({ privateKey: localPrivateKey, publicKey: remotePublicKey });
  return Buffer.from(hkdfSync('sha256', shared, nonce, HKDF_INFO, 32));
}

/**
 * Encrypt a plaintext message with a session key using AES-256-GCM.
 *
 * @param plaintext - The message to encrypt
 * @param sessionKey - 32-byte session key from deriveSessionKey
 * @returns Base64-encoded string: IV (12) || AuthTag (16) || Ciphertext
 */
export function encryptMessage(plaintext: string, sessionKey: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', sessionKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, authTag, encrypted]);
  return packed.toString('base64');
}

/**
 * Decrypt a message encrypted with encryptMessage.
 *
 * @param encrypted - Base64-encoded string: IV (12) || AuthTag (16) || Ciphertext
 * @param sessionKey - 32-byte session key (must match the key used for encryption)
 * @returns Decrypted plaintext string
 * @throws If the session key is wrong or the ciphertext has been tampered with
 */
export function decryptMessage(encrypted: string, sessionKey: Buffer): string {
  const packed = Buffer.from(encrypted, 'base64');
  if (packed.length < IV_LEN + TAG_LEN) {
    throw new Error('Invalid encrypted message: too short');
  }
  const iv = packed.subarray(0, IV_LEN);
  const authTag = packed.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = packed.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', sessionKey, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** Length of the server nonce in `peer.hello`. */
export const HANDSHAKE_NONCE_BYTES = 32;
/** Length of a mutual-v2 proof (HMAC-SHA256). */
export const PEER_PROOF_BYTES = 32;

const TRANSCRIPT_LABEL = 'kici-peer-auth-v2';
const CLIENT_PROOF_LABEL = 'kici-peer-v2/client';
const SERVER_PROOF_LABEL = 'kici-peer-v2/server';
const APP_KEY_INFO = 'kici-peer-v2/app';

/** Encode each field as a 4-byte big-endian length followed by its bytes. */
export function lengthPrefixed(...fields: Array<Buffer | string>): Buffer {
  const parts: Buffer[] = [];
  for (const value of fields) {
    const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
    const header = Buffer.alloc(4);
    header.writeUInt32BE(bytes.length, 0);
    parts.push(header, bytes);
  }
  return Buffer.concat(parts);
}

export interface PeerTranscriptInput {
  serverEphemeralPublicKey: Buffer;
  serverNonce: Buffer;
  /** The schemes exactly as the server advertised them, unknown ones included. */
  authSchemes: readonly string[];
  clientEphemeralPublicKey: Buffer;
}

/** TH: binds both ephemeral keys, the nonce and the advertised schemes. */
export function peerTranscriptHash(input: PeerTranscriptInput): Buffer {
  return createHash('sha256')
    .update(
      lengthPrefixed(
        TRANSCRIPT_LABEL,
        input.serverEphemeralPublicKey,
        input.serverNonce,
        input.authSchemes.join(','),
        input.clientEphemeralPublicKey,
      ),
    )
    .digest();
}

export interface ClientProofInput {
  psk: Buffer;
  transcriptHash: Buffer;
  mode: string;
  clientInstanceId: string;
  role: string;
  protocolVersion: number;
  /** The join token's routing segment in token mode; empty in credential mode. */
  tokenRouting: string;
}

export function computeClientProof(input: ClientProofInput): Buffer {
  return createHmac('sha256', input.psk)
    .update(
      lengthPrefixed(
        CLIENT_PROOF_LABEL,
        input.transcriptHash,
        input.mode,
        input.clientInstanceId,
        input.role,
        String(input.protocolVersion),
        input.tokenRouting,
      ),
    )
    .digest();
}

export interface ServerProofInput {
  psk: Buffer;
  transcriptHash: Buffer;
  clientProof: Buffer;
  serverInstanceId: string;
  grantedRole: string;
  /** The credential the server issues in this response, or null when it issues none. */
  sessionCredential: string | null;
}

export function computeServerProof(input: ServerProofInput): Buffer {
  const credentialDigest =
    input.sessionCredential === null
      ? Buffer.alloc(0)
      : createHash('sha256').update(input.sessionCredential, 'utf8').digest();
  return createHmac('sha256', input.psk)
    .update(
      lengthPrefixed(
        SERVER_PROOF_LABEL,
        input.transcriptHash,
        input.clientProof,
        input.serverInstanceId,
        input.grantedRole,
        credentialDigest,
      ),
    )
    .digest();
}

/** A proof as sent on the wire (64 hex characters), or null when malformed. */
export function decodeProof(hex: string): Buffer | null {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return Buffer.from(hex, 'hex');
}

/** Constant-time comparison; a length mismatch is a mismatch, never a throw. */
export function proofMatches(expected: Buffer, presented: Buffer): boolean {
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/** K_app: protects every frame after acceptance, and needs the PSK as well as K_hs. */
export function deriveAppKey(input: {
  handshakeKey: Buffer;
  psk: Buffer;
  transcriptHash: Buffer;
  clientProof: Buffer;
  serverProof: Buffer;
}): Buffer {
  const salt = createHash('sha256')
    .update(Buffer.concat([input.transcriptHash, input.clientProof, input.serverProof]))
    .digest();
  return Buffer.from(
    hkdfSync('sha256', Buffer.concat([input.handshakeKey, input.psk]), salt, APP_KEY_INFO, 32),
  );
}
