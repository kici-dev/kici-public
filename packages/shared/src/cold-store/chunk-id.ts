/**
 * A chunk ID is a function of `(db, table, tenantId, partitionDate, minRowId,
 * maxRowId)`, so a re-run of an interrupted archival pass writes the same S3
 * key: the core of the idempotency guarantee. 16 hex characters (64 bits of
 * sha256) avoid collisions: at a million chunks the birthday probability is ~3e-8.
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
