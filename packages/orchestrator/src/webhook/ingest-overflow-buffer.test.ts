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
 * Minimal fake of the Kysely calls the buffer makes:
 *  - selectFrom('ingest_overflow_buffer').select(count).where(status=buffered) → count
 *  - insertInto('ingest_overflow_buffer').values(row).returning('id').executeTakeFirst()
 *  - updateTable('ingest_overflow_buffer').set(patch).where(id).where(status?) → claim / settle
 */
function makeFakeDb(rows: Array<Record<string, unknown>>): Kysely<Database> {
  let nextId = 1;
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
        returning: () => ({
          executeTakeFirst: async () => {
            const withId = { id: nextId++, ...v };
            rows.push(withId);
            return { id: withId.id };
          },
        }),
      }),
    }),
    updateTable: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: (_c: string, _o: string, val: unknown) => {
          const settle = (extra?: { col: string; val: unknown }) => ({
            executeTakeFirst: async () => {
              const target = rows.find(
                (r) => r.id === val && (!extra || r[extra.col] === extra.val),
              );
              if (!target) return { numUpdatedRows: 0n };
              Object.assign(target, patch);
              return { numUpdatedRows: 1n };
            },
            execute: async () => {
              const target = rows.find((r) => r.id === val);
              if (target) Object.assign(target, patch);
            },
          });
          return {
            where: (c2: string, _o2: string, v2: unknown) => settle({ col: c2, val: v2 }),
            ...settle(),
          };
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
  it('enqueue returns the new row id so the accept path can claim it', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const buf = new IngestOverflowBuffer({ db: makeFakeDb(rows), maxRows: 3 });
    const id = await buf.enqueue(delivery('d-1'));
    // The id is what makes the durable row addressable: without it the accept
    // path could store a delivery and then be unable to claim or settle it.
    expect(id).toBe(1);
    expect(rows[0]!.status).toBe('buffered');
  });

  it('enqueue returns null at the cap so the caller can refuse to acknowledge', async () => {
    const rows: Array<Record<string, unknown>> = [{ status: 'buffered' }, { status: 'buffered' }];
    const buf = new IngestOverflowBuffer({ db: makeFakeDb(rows), maxRows: 2 });
    expect(await buf.enqueue(delivery('d-3'))).toBeNull();
    expect(rows).toHaveLength(2);
  });

  it('claimRow takes a buffered row exactly once', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const buf = new IngestOverflowBuffer({ db: makeFakeDb(rows), maxRows: 3 });
    const id = (await buf.enqueue(delivery('d-1')))!;

    expect(await buf.claimRow(id)).toBe(true);
    expect(rows[0]!.status).toBe('replaying');
    expect(rows[0]!.claimed_at).toBeInstanceOf(Date);

    // A second claimant loses: the conditional update is what stops two workers
    // dispatching the same delivery.
    expect(await buf.claimRow(id)).toBe(false);
  });

  it('markProcessed leaves the row for the drain sweep rather than deleting it', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const buf = new IngestOverflowBuffer({ db: makeFakeDb(rows), maxRows: 3 });
    const id = (await buf.enqueue(delivery('d-1')))!;
    await buf.claimRow(id);
    await buf.markProcessed(id);
    expect(rows[0]!.status).toBe('replayed');
    expect(rows[0]!.last_error).toBeNull();
  });
});
