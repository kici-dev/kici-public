/**
 * Shared IP extraction helper with trusted proxy + CIDR support.
 *
 * Used by app.ts to extract the real client IP from Hono context,
 * respecting proxy headers only when the direct connection comes
 * from a configured trusted proxy.
 */

import { isIP, isIPv4 } from 'node:net';
import type { Context } from 'hono';
import type { ConnInfo } from 'hono/conninfo';

/**
 * Normalize an IP address by stripping the IPv6-mapped IPv4 prefix.
 * E.g., '::ffff:127.0.0.1' -> '127.0.0.1'
 */
export function normalizeIp(ip: string): string {
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) | parseInt(octet, 10), 0) >>> 0;
}

function isInCidr(ip: string, cidr: string): boolean {
  const normalized = normalizeIp(ip);
  if (!cidr.includes('/')) return normalized === normalizeIp(cidr);
  const [subnet, bits] = cidr.split('/');
  const maskBits = parseInt(bits!, 10);
  if (!isIPv4(normalized) || !isIPv4(subnet!)) return false;
  const ipNum = ipToInt(normalized);
  const subnetNum = ipToInt(subnet!);
  const mask = ~((1 << (32 - maskBits)) - 1) >>> 0;
  return (ipNum & mask) === (subnetNum & mask);
}

/**
 * Check if a socket IP is a trusted proxy.
 * Supports exact IP matches and CIDR ranges.
 * IPv6-mapped IPv4 addresses are normalized before comparison.
 */
export function isTrustedProxy(socketIp: string, trustedProxies: string[]): boolean {
  const normalized = normalizeIp(socketIp);
  return trustedProxies.some((proxy) => {
    if (proxy.includes('/')) return isInCidr(normalized, proxy);
    return normalized === normalizeIp(proxy);
  });
}

/**
 * Extract the real remote IP from a Hono request context.
 *
 * - If the direct socket is a trusted proxy, reads X-Real-IP or X-Forwarded-For
 * - Otherwise, returns the socket IP directly (ignoring proxy headers)
 * - Returns 'unknown' if socket address is not available
 */
export function extractRemoteIp(c: Context, connInfo: ConnInfo, trustedProxies: string[]): string {
  const socketIp = connInfo.remote?.address ?? 'unknown';
  if (socketIp === 'unknown') return socketIp;
  if (!isTrustedProxy(socketIp, trustedProxies)) return normalizeIp(socketIp);

  const xRealIp = c.req.header('X-Real-IP');
  if (xRealIp && isIP(xRealIp)) return normalizeIp(xRealIp);

  const xff = c.req.header('X-Forwarded-For');
  if (xff) {
    const firstIp = xff.split(',')[0]?.trim();
    if (firstIp && isIP(firstIp)) return normalizeIp(firstIp);
  }

  return normalizeIp(socketIp);
}
