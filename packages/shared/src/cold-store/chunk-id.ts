/**
 * Deterministic chunk ID computation.
 *
 * A chunk's ID is derived from the tuple
 * `(db, table, tenantId, partitionDate, minRowId, maxRowId)` so that
 * re-running an interrupted archival pass always produces the same ID
 * and therefore the same S3 object key. This is the core of the
 * idempotency guarantee documented in the design doc section 3.
 *
 * 16 hex characters (64 bits of sha256) is enough to avoid collisions:
 * at a trillion chunks, birthday probability is ~5e-8.
 */
import { sha256 } from '@kici-dev/core';
import type { DbKind } from './key.js';

export function computeChunkId(args: {
  db: DbKind;
  table: string;
  tenantId: string;
  partitionDate: string;
  minRowId: string | number;
  maxRowId: string | number;
}): string {
  const input = [
    args.db,
    args.table,
    args.tenantId,
    args.partitionDate,
    String(args.minRowId),
    String(args.maxRowId),
  ].join('|');
  return sha256(input).slice(0, 16);
}
