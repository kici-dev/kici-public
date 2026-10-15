import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify a GitHub webhook signature (HMAC-SHA256) in constant time.
 *
 * @param signature - The X-Hub-Signature-256 header value
 */
export function verifySignature(body: string, signature: string, secret: string): boolean {
  if (!signature.startsWith('sha256=')) {
    return false;
  }

  const providedHex = signature.slice(7); // Remove "sha256="

  const hmac = createHmac('sha256', secret);
  hmac.update(body, 'utf8');
  const expectedHex = hmac.digest('hex');

  // timingSafeEqual throws on a length mismatch.
  if (providedHex.length !== expectedHex.length) {
    return false;
  }

  // Buffer.from(str, 'hex') silently drops non-hex characters, so 64 non-hex
  // chars pass the string length check but yield a shorter buffer.
  const providedBuffer = Buffer.from(providedHex, 'hex');
  const expectedBuffer = Buffer.from(expectedHex, 'hex');

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}
