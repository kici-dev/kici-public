import { describe, it, expect, beforeEach } from 'vitest';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { IngestOverflowBuffer } from './ingest-overflow-buffer.js';
import { OverflowSourceKind, type OverflowDelivery } from './ingest-overflow-types.js';
import {
  getIngestOverflowBuffered,
  resetIngestOverflowMetricState,
} from '../metrics/prometheus.js';

/**
 * Minimal fake of the two Kysely calls the buffer makes:
 *  - selectFrom('ingest_overflow_buffer').select(count).where(status=buffered) → count
 *  - insertInto('ingest_overflow_buffer').values(row).execute()
 */
function makeFakeDb(rows: Array<Record<string, unknown>>): Kysely<Database> {
  return {
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          executeTakeFirstOrThrow: async () => ({
            count: String(rows.filter((r) => r.status === 'buffered').length),
          }),
        }),
      }),
    }),
    insertInto: () => ({
      values: (v: Record<string, unknown>) => ({
        execute: async () => {
          rows.push(v);
        },
      }),
    }),
  } as unknown as Kysely<Database>;
}

const delivery = (id: string): OverflowDelivery => ({
  deliveryId: id,
  routingKey: 'github:1',
  sourceKind: OverflowSourceKind.enum.direct,
  provider: 'github',
  event: 'push',
  action: null,
  body: Buffer.from('{}').toString('base64'),
  meta: { signatureHeaderName: null, signatureHeader: null, clientIp: null, headers: {} },
});

describe('IngestOverflowBuffer', () => {
  beforeEach(() => resetIngestOverflowMetricState());

  it('inserts a buffered row under the cap and returns true', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const buf = new IngestOverflowBuffer({ db: makeFakeDb(rows), maxRows: 3 });
    const ok = await buf.capture(delivery('d-1'));
    expect(ok).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('buffered');
    expect(rows[0]!.delivery_id).toBe('d-1');
    expect(getIngestOverflowBuffered()).toBe(1);
  });

  it('drops at cap: no insert, returns false', async () => {
    const rows: Array<Record<string, unknown>> = [
      { status: 'buffered' },
      { status: 'buffered' },
      { status: 'buffered' },
    ];
    const buf = new IngestOverflowBuffer({ db: makeFakeDb(rows), maxRows: 3 });
    const ok = await buf.capture(delivery('d-4'));
    expect(ok).toBe(false);
    expect(rows).toHaveLength(3); // unchanged
  });
});
