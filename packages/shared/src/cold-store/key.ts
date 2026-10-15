/**
 * Key helpers for S3 object layouts.
 *
 * `encodeKeySegment` lets user-controlled values (delivery IDs, routing keys,
 * org IDs, partition values) sit in an object key without breaking its
 * structure. Its encoding MUST NOT change: already-written chunk and event-log
 * keys depend on the mapping staying stable forever, and a fixture test in
 * key.test.ts locks it.
 */

/**
 * Encode a single S3 path segment: anything outside `[A-Za-z0-9._:-]`
 * becomes `_<hex>`, the lowercase hex of the character's UTF-16 code unit.
 */
export function encodeKeySegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._:-]/g, (ch) => `_${ch.charCodeAt(0).toString(16)}`);
}

/** DB identifier for cold-store chunk keys. */
export type DbKind = 'platform' | 'orchestrator';

/** Prefix for a table's cold-store objects: `<prefix>/<db>/<table>`. */
export function tablePrefix(args: { prefix: string; db: DbKind; table: string }): string {
  const stripped = args.prefix.replace(/\/+$/, '');
  return `${stripped}/${args.db}/${args.table}`;
}

/**
 * Prefix for a tenant's day-partitioned objects:
 * `<prefix>/<db>/<table>/<tenantId>/<YYYY>/<MM>/<DD>`, with `tenantId` encoded.
 * `partitionDate` must be `YYYY-MM-DD`.
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
 * Bucket segment (`30d`, `1y`, `forever`, …): lowercase letters and digits
 * only, which keeps the S3 path safe (no `/`, no `.`, no path traversal).
 */
const BUCKET_SEGMENT_RE = /^[a-z0-9]+$/;

/**
 * Tenant-day prefix plus the cold-bucket segment:
 * `<prefix>/<db>/<table>/<tenantId>/<YYYY>/<MM>/<DD>/<bucket>`.
 *
 * V1 chunks live at the day-prefix root (`tenantDayPrefix`). `parseManifest`
 * treats them as the `'forever'` bucket, but their key carries no `forever`
 * segment: the chunk-purge sweep keys off the manifest's `bucket` /
 * `maxColdDays`, not the path.
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
 * Full object key for a cold-store chunk or its manifest.
 *
 * - V1 (no `bucket`): `<tenant-day-prefix>/<chunkId>.<ext>`, kept so V1
 *   chunks read back.
 * - V2 (with `bucket`): `<tenant-day-prefix>/<bucket>/<chunkId>.<ext>`, so
 *   the GC sweep lists one bucket subprefix instead of scanning the whole day.
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
