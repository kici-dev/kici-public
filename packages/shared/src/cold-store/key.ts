/**
 * Key helpers for S3 object layouts.
 *
 * `encodeKeySegment` escapes non-safe characters in a single path segment
 * so that values coming from user-controlled sources (delivery IDs,
 * routing keys, org IDs, partition values) can be embedded in an object
 * key without breaking the key structure.
 *
 * This function was originally defined in
 * packages/orchestrator/src/webhook/event-log.ts and is now shared with
 * the cold-store framework. The encoding algorithm MUST NOT change —
 * previously-written chunk and event-log keys depend on this mapping
 * remaining stable forever. A fixture test in key.test.ts locks the
 * behavior.
 */

/**
 * Encode a single S3 path segment: anything outside `[A-Za-z0-9._:-]`
 * becomes `_<hex>` where `<hex>` is the lowercase UTF-16 code unit of
 * the replaced character (same as `ch.charCodeAt(0).toString(16)`).
 */
export function encodeKeySegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._:-]/g, (ch) => `_${ch.charCodeAt(0).toString(16)}`);
}

/**
 * DB identifier for cold-store chunk keys.
 */
export type DbKind = 'platform' | 'orchestrator';

/**
 * Compose the prefix for a specific table's cold-store objects.
 *
 * Layout: `<prefix>/<db>/<table>`.
 */
export function tablePrefix(args: { prefix: string; db: DbKind; table: string }): string {
  const stripped = args.prefix.replace(/\/+$/, '');
  return `${stripped}/${args.db}/${args.table}`;
}

/**
 * Compose the prefix for a specific tenant's day-partitioned objects.
 *
 * Layout: `<prefix>/<db>/<table>/<tenantId>/<YYYY>/<MM>/<DD>`.
 * `tenantId` is encoded via `encodeKeySegment`.
 * `partitionDate` must be `YYYY-MM-DD` (no other format is accepted).
 */
export function tenantDayPrefix(args: {
  prefix: string;
  db: DbKind;
  table: string;
  tenantId: string;
  partitionDate: string;
}): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.partitionDate)) {
    throw new Error(`partitionDate must be YYYY-MM-DD, got ${JSON.stringify(args.partitionDate)}`);
  }
  const [yyyy, mm, dd] = args.partitionDate.split('-');
  const encodedTenant = encodeKeySegment(args.tenantId);
  return `${tablePrefix(args)}/${encodedTenant}/${yyyy}/${mm}/${dd}`;
}

/**
 * Allowed bucket-segment shape: lowercase letters, digits, the literal
 * `forever`, e.g. `30d` / `180d` / `1y` / `2y` / `forever`. Validated to
 * keep the S3 path safe (no `/`, no `.`, no path traversal).
 */
const BUCKET_SEGMENT_RE = /^[a-z0-9]+$/;

/**
 * Compose a tenant-day prefix that includes the cold-bucket segment
 * introduced in Phase 2. Layout:
 *
 *   `<prefix>/<db>/<table>/<tenantId>/<YYYY>/<MM>/<DD>/<bucket>`
 *
 * Phase-1 (v1 manifest) chunks live at the day-prefix root and are
 * addressed via `tenantDayPrefix` directly — those legacy chunks are
 * treated as the `'forever'` bucket by `parseManifest` but DO NOT carry
 * a `forever` segment in their key (the chunk-purge sweep keys off the
 * manifest's `bucket` / `maxColdDays`, not the path).
 */
export function tenantDayBucketPrefix(args: {
  prefix: string;
  db: DbKind;
  table: string;
  tenantId: string;
  partitionDate: string;
  bucket: string;
}): string {
  if (!BUCKET_SEGMENT_RE.test(args.bucket)) {
    throw new Error(
      `bucket must match ${BUCKET_SEGMENT_RE.source}, got ${JSON.stringify(args.bucket)}`,
    );
  }
  return `${tenantDayPrefix(args)}/${args.bucket}`;
}

/**
 * Compose a full object key for a cold-store chunk or its manifest.
 *
 * - V1 (no `bucket` arg): `<tenant-day-prefix>/<chunkId>.<ext>` — original
 *   layout, preserved for read-back compatibility with V1 chunks.
 * - V2 (with `bucket`): `<tenant-day-prefix>/<bucket>/<chunkId>.<ext>` —
 *   the GC sweep can list a single bucket subprefix to find purge
 *   candidates without scanning the whole day.
 */
export function chunkObjectKey(args: {
  prefix: string;
  db: DbKind;
  table: string;
  tenantId: string;
  partitionDate: string;
  chunkId: string;
  kind: 'data' | 'manifest';
  bucket?: string;
}): string {
  const suffix = args.kind === 'data' ? '.jsonl.gz' : '.manifest.json';
  const dir = args.bucket
    ? tenantDayBucketPrefix({ ...args, bucket: args.bucket })
    : tenantDayPrefix(args);
  return `${dir}/${args.chunkId}${suffix}`;
}
