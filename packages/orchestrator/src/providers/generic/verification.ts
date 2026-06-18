/**
 * Generic webhook verification module.
 *
 * Supports multiple verification methods for non-GitHub webhook sources:
 * - HMAC-SHA256 signature verification (reuses engine's verifySignature)
 * - Bearer token comparison (constant-time)
 * - IP allowlist (exact match)
 * - None (no verification, always passes)
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { verifySignature } from '@kici-dev/engine/webhook/signature';

/** Supported verification methods */
export type VerificationMethod = 'hmac_sha256' | 'bearer_token' | 'ip_allowlist' | 'none';

/** HMAC-SHA256 verification config */
export interface HmacVerificationConfig {
  method: 'hmac_sha256';
  secret: string;
  /** Header containing the signature (default: x-signature-256) */
  headerName?: string;
}

/** Bearer token verification config */
export interface BearerVerificationConfig {
  method: 'bearer_token';
  token: string;
  /** Header containing the token (default: authorization) */
  headerName?: string;
}

/** IP allowlist verification config */
export interface IpAllowlistVerificationConfig {
  method: 'ip_allowlist';
  allowlist: string[];
}

/** No verification config */
export interface NoneVerificationConfig {
  method: 'none';
}

/** Discriminated union of all verification configs */
export type VerificationConfig =
  | HmacVerificationConfig
  | BearerVerificationConfig
  | IpAllowlistVerificationConfig
  | NoneVerificationConfig;

/**
 * Verify a generic webhook request.
 *
 * @param body - Raw request body as string
 * @param headers - Request headers (lowercase keys)
 * @param config - Verification configuration for this source
 * @param clientIp - Client IP address (required for ip_allowlist method)
 * @returns true if verification passes
 */
export function verifyGenericWebhook(
  body: string,
  headers: Record<string, string>,
  config: VerificationConfig,
  clientIp?: string,
): boolean {
  switch (config.method) {
    case 'hmac_sha256':
      return verifyHmac(body, headers, config);
    case 'bearer_token':
      return verifyBearer(headers, config);
    case 'ip_allowlist':
      return verifyIpAllowlist(clientIp, config);
    case 'none':
      return true;
  }
}

/**
 * Verify HMAC-SHA256 signature.
 * Reuses engine's verifySignature for the actual HMAC comparison.
 *
 * Supports two formats:
 * - With "sha256=" prefix (GitHub-style): delegates to engine verifySignature
 * - Raw hex digest: computes HMAC and does timing-safe comparison
 */
function verifyHmac(
  body: string,
  headers: Record<string, string>,
  config: HmacVerificationConfig,
): boolean {
  const headerName = config.headerName ?? 'x-signature-256';
  const signature = headers[headerName];
  if (!signature) {
    return false;
  }

  // If signature has sha256= prefix, delegate to engine's verifySignature
  if (signature.startsWith('sha256=')) {
    return verifySignature(body, signature, config.secret);
  }

  // Otherwise, treat as raw hex digest
  const hmac = createHmac('sha256', config.secret);
  hmac.update(body, 'utf8');
  const expectedHex = hmac.digest('hex');

  if (signature.length !== expectedHex.length) {
    return false;
  }

  const providedBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expectedHex, 'hex');

  // Buffer.from silently drops invalid hex chars, producing a shorter buffer.
  // Compare buffer lengths to avoid timingSafeEqual throwing RangeError.
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

/**
 * Verify bearer token using constant-time comparison.
 */
function verifyBearer(headers: Record<string, string>, config: BearerVerificationConfig): boolean {
  const headerName = config.headerName ?? 'authorization';
  const headerValue = headers[headerName];
  if (!headerValue) {
    return false;
  }

  // Strip "Bearer " prefix if present
  const token = headerValue.startsWith('Bearer ') ? headerValue.slice(7) : headerValue;

  // Constant-time comparison
  const expectedBuffer = Buffer.from(config.token, 'utf8');
  const providedBuffer = Buffer.from(token, 'utf8');

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

/**
 * Verify client IP against allowlist (exact match).
 * CIDR range matching can be added later if needed.
 */
function verifyIpAllowlist(
  clientIp: string | undefined,
  config: IpAllowlistVerificationConfig,
): boolean {
  if (!clientIp) {
    return false;
  }
  return config.allowlist.includes(clientIp);
}
