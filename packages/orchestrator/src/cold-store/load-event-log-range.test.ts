import { describe, it, expect, vi } from 'vitest';
import type { ColdStore } from '@kici-dev/shared';
import { loadEventLogRange, type EventLogColdStoreRow } from './load-event-log-range.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';

/**
 * Mirrors the cold-store error coverage of the access-log and secret-audit-log loaders: a
 * transient cold failure on a page with no hot rows (offset past the warm tail) must not look
 * like end-of-data. `loadEventLogByDeliveryId` is best-effort and never throws, so it is not
 * exercised here.
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

function makeColdStoreMock(opts: {
  rows?: EventLogColdStoreRow[];
  throwOnFetch?: Error;
  warmCutoff?: Date;
}): {
  coldStore: ColdStore;
  fetchRange: ReturnType<typeof vi.fn>;
} {
  const fetchRange = vi.fn((args: { order?: 'asc' | 'desc' }) => {
    if (opts.throwOnFetch) {
      const err = opts.throwOnFetch;
      async function* throwingGen(): AsyncGenerator<EventLogColdStoreRow> {
        throw err;
        yield undefined as never;
      }
      return throwingGen();
    }
    // Honour `order` like the real store, so a reader that forgets `desc` gets the oldest rows.
    const seed = [...(opts.rows ?? [])].sort((a, b) => {
      const d = new Date(a.received_at).getTime() - new Date(b.received_at).getTime();
      return args.order === 'desc' ? -d : d;
    });
    async function* gen(): AsyncGenerator<EventLogColdStoreRow> {
      for (const r of seed) yield r;
    }
    return gen();
  });
  const warmCutoff = vi.fn(() => opts.warmCutoff ?? new Date(Date.now() - 30 * 86_400_000));
  return { coldStore: { fetchRange, warmCutoff } as unknown as ColdStore, fetchRange };
}

/**
 * Mocks the hot page SELECT (returns hotRows) and the cold-offset count (returns `{ n }`).
 * `hotCount` is the total matching hot-row count that sets the cold offset.
 */
function makeMockDb(hotRows: EventLogColdStoreRow[], hotCount: number = hotRows.length) {
  return createMockDb({ selectRows: hotRows, selectFirstRow: { n: String(hotCount) } }).db;
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

  it('skips cold entirely when the requested window starts after the store warm cutoff', async () => {
    // Cutoff 100 days back and a 10-day window: nothing in it can be archived.
    const { coldStore, fetchRange } = makeColdStoreMock({
      rows: [SAMPLE_COLD_1],
      warmCutoff: new Date(Date.now() - 100 * 86_400_000),
    });

    await loadEventLogRange({
      db: makeMockDb([]),
      coldStore,
      routingKey: 'github:1',
      limit: 50,
      offset: 0,
      includeArchived: true,
      fromTs: new Date(Date.now() - 10 * 86_400_000),
    });

    expect(fetchRange).not.toHaveBeenCalled();
  });

  it('consults cold when the store warm cutoff is lowered below the requested window', async () => {
    // A 2-day cutoff archives older rows, so a 10-day window MUST reach cold; a reader holding a
    // 30-day literal would skip the read.
    const { coldStore, fetchRange } = makeColdStoreMock({
      rows: [SAMPLE_COLD_1],
      warmCutoff: new Date(Date.now() - 2 * 86_400_000),
    });

    await loadEventLogRange({
      db: makeMockDb([]),
      coldStore,
      routingKey: 'github:1',
      limit: 50,
      offset: 0,
      includeArchived: true,
      fromTs: new Date(Date.now() - 10 * 86_400_000),
    });

    expect(fetchRange).toHaveBeenCalledTimes(1);
  });
});

// The loader must ask `fetchRange` for the newest rows first and stop
// once the page is full; the mock only orders rows when asked to.
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
    const { coldStore, fetchRange } = makeColdStoreMock({ rows: [COLD_OLD, COLD_MID, COLD_NEW] });

    const result = await loadEventLogRange({
      db: makeMockDb([]),
      coldStore,
      routingKey: 'github:1',
      limit: 2,
      offset: 0,
      includeArchived: true,
    });

    // fails-when: the reader drops `order: 'desc'` — the mock then yields
    // oldest-first and the page reads ['cold-old', 'cold-mid'].
    expect((fetchRange.mock.calls[0][0] as { order?: string }).order).toBe('desc');
    expect(result.map((r) => r.id)).toEqual(['cold-new', 'cold-mid']);
  });

  it('offsets the cold slice by (offset - hotCount) when paginating past the hot tail', async () => {
    const { coldStore } = makeColdStoreMock({ rows: [COLD_OLD, COLD_MID, COLD_NEW] });

    // 2 hot rows and offset 3 → coldOffset = 1: the newest cold row was on the previous page.
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
