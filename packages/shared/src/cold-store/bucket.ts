/**
 * Cold-bucket classification.
 *
 * The bucket name is the S3-prefix dimension; the chunk's manifest
 * carries the row-level `maxColdDays` for the GC sweep so multiple
 * actions sharing a bucket don't collapse to the most-conservative TTL.
 */
import type { ColdRetention } from './types.js';

/**
 * Map a `ColdRetention` to a stable S3 prefix segment. Rounds
 * non-canonical TTLs DOWN so the chunk lives at LEAST as long as any
 * row in it requires (we never purge sooner than the row's declared
 * retention).
 */
export function coldDaysToBucket(days: ColdRetention): string {
  if (days === 'forever') return 'forever';
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) {
    throw new Error(
      `coldDaysToBucket: invalid retention value ${JSON.stringify(days)} — expected a positive finite number or 'forever'. Engine retention policy returned undefined for an unknown action; ensure the policy has a fallback.`,
    );
  }
  if (days <= 30) return '30d';
  if (days <= 180) return '180d';
  if (days <= 365) return '1y';
  if (days <= 730) return '2y';
  return `${days}d`;
}

/**
 * Compare two `ColdRetention` values for "which retains longer." Used by
 * the framework to compute `maxColdDays` across rows in a chunk.
 *
 * `'forever' > N` for any number `N`. Among numbers, larger wins.
 */
export function isLongerColdRetention(a: ColdRetention, b: ColdRetention): boolean {
  if (a === 'forever') return b !== 'forever';
  if (b === 'forever') return false;
  return a > b;
}

/** Stable, ordered set of bucket names emitted by `coldDaysToBucket`. */
export const COLD_BUCKET_NAMES = ['30d', '180d', '1y', '2y', 'forever'] as const;
export type ColdBucketName = (typeof COLD_BUCKET_NAMES)[number];
