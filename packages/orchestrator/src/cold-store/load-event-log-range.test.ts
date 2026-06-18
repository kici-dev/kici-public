import { describe, it, expect, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { ColdStore } from '@kici-dev/shared';
import { loadEventLogRange, type EventLogColdStoreRow } from './load-event-log-range.js';
import type { Database } from '../db/types.js';

/**
 * Direct unit tests for `loadEventLogRange`. Mirror the
 * `load-access-log-range.test.ts` and `load-secret-audit-log-range.test.ts`
 * coverage of the cold-store error branch — without these, a transient
 * cold-store failure on a paginated request that has no hot rows
 * (offset past the warm tail) would silently look like end-of-data.
 *
 * `loadEventLogByDeliveryId` is a separate single-row detail lookup
 * with a deliberate "best-effort, never throws" contract; it is NOT
 * exercised here on purpose.
 */

const COLD_DAY = new Date('2026-01-01T00:00:00.000Z'); // older than warm cutoff

const SAMPLE_COLD_1: EventLogColdStoreRow = {
  id: 'cold-1',
  org_id: 'org-1',
  delivery_id: 'delivery-cold-1',
  routing_key: 'github:1',
  event: 'push',
  action: null,
  source: 'relay',
  provider: 'github',
  repo_identifier: 'a/b',
  ref: 'refs/heads/main',
  payload_key: null,
  payload_omitted: false,
  payload_omitted_reason: null,
  payload_size_bytes: 0,
  payload_hash: 'sha256-x',
  matched_count: 0,
  status: 'processed',
  run_id: null,
  error_message: null,
  received_at: COLD_DAY,
  archived_at: null,
  archive_object_key: null,
} as unknown as EventLogColdStoreRow;

const SAMPLE_HOT_1: EventLogColdStoreRow = {
  ...SAMPLE_COLD_1,
  id: 'hot-1',
  delivery_id: 'delivery-hot-1',
  received_at: new Date(),
} as EventLogColdStoreRow;

function makeColdStoreMock(opts: { rows?: EventLogColdStoreRow[]; throwOnFetch?: Error }): {
  coldStore: ColdStore;
  fetchRange: ReturnType<typeof vi.fn>;
} {
  const fetchRange = vi.fn(() => {
    if (opts.throwOnFetch) {
      const err = opts.throwOnFetch;
      async function* throwingGen(): AsyncGenerator<EventLogColdStoreRow> {
        throw err;
        yield undefined as never;
      }
      return throwingGen();
    }
    const seed = opts.rows ?? [];
    async function* gen(): AsyncGenerator<EventLogColdStoreRow> {
      for (const r of seed) yield r;
    }
    return gen();
  });
  return { coldStore: { fetchRange } as unknown as ColdStore, fetchRange };
}

/**
 * Mock the two Kysely queries `loadEventLogRange` issues against the
 * hot table: the page SELECT (`selectFrom → selectAll → where* →
 * orderBy → limit → offset → execute`, returns hotRows) and the
 * cold-offset count (`selectFrom → select → where* → executeTakeFirst`,
 * returns `{ n }`). Each `where(...)` returns the same builder so the
 * optional filter chain works regardless of how many filters the caller
 * supplies. `hotCount` is the total matching hot-row count used to
 * compute the cold-side offset; it defaults to the seeded page length.
 */
function makeMockDb(
  hotRows: EventLogColdStoreRow[],
  hotCount: number = hotRows.length,
): Kysely<Database> {
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn(() => builder);
  builder.selectAll = vi.fn(() => builder);
  builder.where = vi.fn(() => builder);
  builder.orderBy = vi.fn(() => builder);
  builder.limit = vi.fn(() => builder);
  builder.offset = vi.fn(() => builder);
  builder.execute = vi.fn().mockResolvedValue(hotRows);
  builder.executeTakeFirst = vi.fn().mockResolvedValue({ n: String(hotCount) });
  const selectFrom = vi.fn(() => builder);
  return { selectFrom } as unknown as Kysely<Database>;
}

describe('loadEventLogRange cold-store error propagation', () => {
  it('throws when hotRows is empty (offset past hot tail) and coldStore fails', async () => {
    const { coldStore, fetchRange } = makeColdStoreMock({
      throwOnFetch: new Error('S3 outage'),
    });

    await expect(
      loadEventLogRange({
        db: makeMockDb([]),
        coldStore,
        routingKey: 'github:1',
        limit: 50,
        offset: 100,
        includeArchived: true,
      }),
    ).rejects.toThrow('S3 outage');

    expect(fetchRange).toHaveBeenCalledTimes(1);
    const callArg = fetchRange.mock.calls[0][0] as { tenantId: string; table: string };
    expect(callArg).toMatchObject({ table: 'event_log', tenantId: 'github:1' });
  });

  it('returns hot rows with a soft-fallback warning when coldStore fails in mixed mode', async () => {
    const { coldStore, fetchRange } = makeColdStoreMock({
      throwOnFetch: new Error('S3 outage'),
    });

    const result = await loadEventLogRange({
      db: makeMockDb([SAMPLE_HOT_1]),
      coldStore,
      routingKey: 'github:1',
      limit: 50,
      offset: 0,
      includeArchived: true,
    });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('hot-1');
    expect(fetchRange).toHaveBeenCalledTimes(1);
  });

  it('returns cold rows when hotRows is empty and the cold scan succeeds (regression guard)', async () => {
    const { coldStore, fetchRange } = makeColdStoreMock({ rows: [SAMPLE_COLD_1] });

    const result = await loadEventLogRange({
      db: makeMockDb([]),
      coldStore,
      routingKey: 'github:1',
      limit: 50,
      offset: 0,
      includeArchived: true,
    });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('cold-1');
    expect(fetchRange).toHaveBeenCalledTimes(1);
  });
});

// `fetchRange` yields chunks oldest-first; the loader must collect the
// full cold set, sort `received_at DESC`, then page — never break early
// (which would surface the oldest rows and hide the newest).
const COLD_OLD: EventLogColdStoreRow = {
  ...SAMPLE_COLD_1,
  id: 'cold-old',
  delivery_id: 'd-old',
  received_at: new Date('2026-01-01T00:00:00.000Z'),
} as EventLogColdStoreRow;
const COLD_MID: EventLogColdStoreRow = {
  ...SAMPLE_COLD_1,
  id: 'cold-mid',
  delivery_id: 'd-mid',
  received_at: new Date('2026-01-02T00:00:00.000Z'),
} as EventLogColdStoreRow;
const COLD_NEW: EventLogColdStoreRow = {
  ...SAMPLE_COLD_1,
  id: 'cold-new',
  delivery_id: 'd-new',
  received_at: new Date('2026-01-03T00:00:00.000Z'),
} as EventLogColdStoreRow;

describe('loadEventLogRange cold ordering + offset', () => {
  it('returns the NEWEST cold rows when the cold set exceeds the page (not the oldest)', async () => {
    // fetchRange yields oldest-first, as the real cold-store does.
    const { coldStore } = makeColdStoreMock({ rows: [COLD_OLD, COLD_MID, COLD_NEW] });

    const result = await loadEventLogRange({
      db: makeMockDb([]),
      coldStore,
      routingKey: 'github:1',
      limit: 2,
      offset: 0,
      includeArchived: true,
    });

    expect(result.map((r) => r.id)).toEqual(['cold-new', 'cold-mid']);
  });

  it('offsets the cold slice by (offset - hotCount) when paginating past the hot tail', async () => {
    const { coldStore } = makeColdStoreMock({ rows: [COLD_OLD, COLD_MID, COLD_NEW] });

    // 2 hot rows total in range; caller is on a page whose offset (3)
    // lands one row into the cold stream → coldOffset = 1, so the newest
    // cold row was already returned on the previous page.
    const result = await loadEventLogRange({
      db: makeMockDb([], 2),
      coldStore,
      routingKey: 'github:1',
      limit: 2,
      offset: 3,
      includeArchived: true,
    });

    expect(result.map((r) => r.id)).toEqual(['cold-mid', 'cold-old']);
  });
});
