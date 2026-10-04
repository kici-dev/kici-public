/**
 * The mutual-v2 key schedule written a second time, independently of
 * `cluster/peer-crypto.ts`, so a test that plays one side of a peer handshake
 * catches a construction bug in the production side instead of sharing it.
 */
import { createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';

function field(value: Buffer | string): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([header, bytes]);
}

export function refTranscriptHash(
  serverPub: Buffer,
  serverNonce: Buffer,
  authSchemes: readonly string[],
  clientPub: Buffer,
): Buffer {
  const h = createHash('sha256');
  for (const f of ['kici-peer-auth-v2', serverPub, serverNonce, authSchemes.join(','), clientPub]) {
    h.update(field(f));
  }
  return h.digest();
}

export function refClientProof(o: {
  psk: Buffer;
  th: Buffer;
  mode: string;
  instanceId: string;
  role: string;
  protocolVersion: number;
  tokenRouting: string;
}): Buffer {
  const h = createHmac('sha256', o.psk);
  for (const f of [
    'kici-peer-v2/client',
    o.th,
    o.mode,
    o.instanceId,
    o.role,
    String(o.protocolVersion),
    o.tokenRouting,
  ]) {
    h.update(field(f));
  }
  return h.digest();
}

export function refServerProof(o: {
  psk: Buffer;
  th: Buffer;
  clientProof: Buffer;
  serverInstanceId: string;
  grantedRole: string;
  sessionCredential: string | null;
}): Buffer {
  const credentialDigest =
    o.sessionCredential === null
      ? Buffer.alloc(0)
      : createHash('sha256').update(o.sessionCredential, 'utf8').digest();
  const h = createHmac('sha256', o.psk);
  for (const f of [
    'kici-peer-v2/server',
    o.th,
    o.clientProof,
    o.serverInstanceId,
    o.grantedRole,
    credentialDigest,
  ]) {
    h.update(field(f));
  }
  return h.digest();
}

export function refAppKey(o: {
  handshakeKey: Buffer;
  psk: Buffer;
  th: Buffer;
  clientProof: Buffer;
  serverProof: Buffer;
}): Buffer {
  const salt = createHash('sha256')
    .update(o.th)
    .update(o.clientProof)
    .update(o.serverProof)
    .digest();
  return Buffer.from(
    hkdfSync('sha256', Buffer.concat([o.handshakeKey, o.psk]), salt, 'kici-peer-v2/app', 32),
  );
}

/** A join token in the production format, with its routing segment and stored hash. */
export function makeTestJoinToken(routing: {
  orgId: string;
  routingKey: string;
  expiry: number;
  role: 'coordinator' | 'worker';
}): { token: string; routingB64: string; secretHex: string; tokenHash: string } {
  const secret = randomBytes(32);
  const routingB64 = Buffer.from(JSON.stringify(routing)).toString('base64url');
  return {
    token: `kici_join_v1.${routingB64}.${secret.toString('hex')}`,
    routingB64,
    secretHex: secret.toString('hex'),
    tokenHash: createHash('sha256').update(secret).digest('hex'),
  };
}

/** The PSK a credential-mode peer proves with: the bytes of sha256(credential). */
export function credentialPsk(credential: string): Buffer {
  return createHash('sha256').update(credential, 'utf8').digest();
}

/** The PSK a token-mode peer proves with: the bytes of the stored token hash. */
export function tokenPsk(tokenHash: string): Buffer {
  return Buffer.from(tokenHash, 'hex');
}
