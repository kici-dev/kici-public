import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify GitHub webhook signature using HMAC-SHA256.
 *
 * @param body - Raw webhook payload body (as string)
 * @param signature - Signature from X-Hub-Signature-256 header
 * @param secret - Webhook secret configured on GitHub
 * @returns true if signature is valid, false otherwise
 *
 * Security:
 * - Uses crypto.timingSafeEqual to prevent timing attacks
 * - Validates signature format before comparison
 * - Handles length mismatches before timingSafeEqual (which throws on length mismatch)
 */
export function verifySignature(body: string, signature: string, secret: string): boolean {
  // Check signature has required prefix
  if (!signature.startsWith('sha256=')) {
    return false;
  }

  // Extract hex digest after prefix
  const providedHex = signature.slice(7); // Remove "sha256="

  // Compute expected HMAC-SHA256
  const hmac = createHmac('sha256', secret);
  hmac.update(body, 'utf8');
  const expectedHex = hmac.digest('hex');

  // Check length match before timingSafeEqual (which throws on length mismatch)
  if (providedHex.length !== expectedHex.length) {
    return false;
  }

  // Convert both to Buffers for timing-safe comparison.
  // Buffer.from(str, 'hex') silently drops non-hex characters, so an input like
  // "sha256=zzzz..." (64 non-hex chars) would pass the string length check above
  // but produce a shorter buffer, causing timingSafeEqual to throw.
  const providedBuffer = Buffer.from(providedHex, 'hex');
  const expectedBuffer = Buffer.from(expectedHex, 'hex');

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  // Timing-safe comparison to prevent timing attacks
  return timingSafeEqual(providedBuffer, expectedBuffer);
}
