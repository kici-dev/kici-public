/**
 * HMAC-signed URL tokens for the filesystem cache backend.
 *
 * Pre-signed S3 URLs are not available for filesystem storage, so the
 * filesystem backend mints HMAC-SHA256 tokens that the orchestrator's HTTP
 * blob route verifies before serving / writing a file. Token shape:
 *
 *   `${expiresUnixMs}.${hexSig}`
 *
 * Signature input: `${method}:${key}:${expiresUnixMs}` with HMAC-SHA256 keyed
 * by a per-orchestrator-process secret (random 32-byte hex at boot, persists
 * for the lifetime of the process). Tokens become invalid on orchestrator
 * restart — fine for the filesystem backend's E2E / single-host use case.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Default URL lifetime: 1 hour (matches S3 backend's PUT-URL lifetime). */
export const DEFAULT_SIGN_URL_TTL_MS = 60 * 60 * 1000;

export type SignedMethod = 'GET' | 'PUT';

/**
 * Generate a fresh per-process signing secret. Caller stores it on the
 * orchestrator config object so the same value is used for sign + verify.
 */
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

/**
 * Mint a signed token for the given (method, key, expiry) triple.
 */
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

/**
 * Verify a token. Constant-time signature compare on hex digest length;
 * rejects malformed shapes and expired tokens up-front.
 */
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
