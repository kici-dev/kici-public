/**
 * HMAC-SHA256 URL tokens for the filesystem cache backend (which has no pre-signed S3 URLs);
 * the blob route verifies them before serving / writing a file. Token shape:
 *
 *   `${expiresUnixMs}.${hexSig}`
 *
 * Signs `${method}:${key}:${expiresUnixMs}` with a per-process secret (random 32 bytes at
 * boot), so tokens die on orchestrator restart — fine for single-host / test-sandbox use.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Default URL lifetime: 1 hour. */
export const DEFAULT_SIGN_URL_TTL_MS = 60 * 60 * 1000;

export type SignedMethod = 'GET' | 'PUT';

/** The caller stores it on the orchestrator config, so sign and verify share it. */
export function generateSigningSecret(): string {
  return randomBytes(32).toString('hex');
}

function computeSig(secret: string, method: SignedMethod, key: string, expiresMs: number): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(`${method}:${key}:${expiresMs}`);
  return hmac.digest('hex');
}

export interface SignedToken {
  /** Encoded token string (`${expiresMs}.${sig}`) ready to drop into a URL. */
  token: string;
  /** Expiry timestamp in unix ms — exposed for tests and logging. */
  expiresMs: number;
}

export function signToken(
  secret: string,
  method: SignedMethod,
  key: string,
  ttlMs: number = DEFAULT_SIGN_URL_TTL_MS,
): SignedToken {
  const expiresMs = Date.now() + ttlMs;
  const sig = computeSig(secret, method, key, expiresMs);
  return { token: `${expiresMs}.${sig}`, expiresMs };
}

export type VerifyResult =
  | { ok: true; expiresMs: number }
  | { ok: false; reason: 'malformed' | 'expired' | 'bad-signature' };

/** Constant-time signature compare; rejects malformed and expired tokens up-front. */
export function verifyToken(
  secret: string,
  method: SignedMethod,
  key: string,
  token: string,
): VerifyResult {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'malformed' };
  const expiresStr = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expiresMs = Number(expiresStr);
  if (!Number.isFinite(expiresMs) || expiresMs <= 0) return { ok: false, reason: 'malformed' };
  if (Date.now() > expiresMs) return { ok: false, reason: 'expired' };

  const expectedSig = computeSig(secret, method, key, expiresMs);
  if (sig.length !== expectedSig.length) return { ok: false, reason: 'bad-signature' };

  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expectedSig, 'hex');
  if (a.length !== b.length || a.length === 0) return { ok: false, reason: 'bad-signature' };
  if (!timingSafeEqual(a, b)) return { ok: false, reason: 'bad-signature' };

  return { ok: true, expiresMs };
}
