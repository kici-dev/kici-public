import { describe, it, expect, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { ColdStore } from '@kici-dev/shared';
import { loadAccessLogRange, type AccessLogColdRow } from './load-access-log-range.js';
import type { Database } from '../db/types.js';

/**
 * Direct unit tests for `loadAccessLogRange`. Complements the
 * `AccessLogWriter` tests in `audit/access-log.test.ts`, which only
 * exercise `getById` (the legacy detail lookup). The pagination-with-
 * cold-resume branch handled here had no direct coverage prior to this
 * file — that gap is what let the silent-data-loss bug land.
 */

const COLD_DAY = new Date('2026-01-01T00:00:00.000Z'); // older than warm cutoff
const COLD_DAY_2 = new Date('2026-01-02T00:00:00.000Z');

const SAMPLE_COLD_1: AccessLogColdRow = {
  id: 'cold-1',
  org_id: 'org-1',
  routing_key: 'github:1',
  actor_type: 'user',
  actor_id: 'u-cold',
  actor_meta: null,
  action: 'run.detail.read',
  target_type: null,
  target_id: null,
  request_id: null,
  source: 'platform_proxy',
  outcome: 'allowed',
  error_message: null,
  archived_at: null,
  archive_object_key: null,
  created_at: COLD_DAY,
} as unknown as AccessLogColdRow;

const SAMPLE_COLD_2: AccessLogColdRow = {
  ...SAMPLE_COLD_1,
  id: 'cold-2',
  created_at: COLD_DAY_2,
} as AccessLogColdRow;

function buildColdCursorForId(createdAt: Date, id: string): string {
  const payload = { source: 'cold', createdAt: createdAt.toISOString(), id };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function makeColdStoreMock(opts: { rows?: AccessLogColdRow[]; throwOnFetch?: Error }): {
  coldStore: ColdStore;
  fetchRange: ReturnType<typeof vi.fn>;
} {
  const fetchRange = vi.fn(() => {
    if (opts.throwOnFetch) {
      const err = opts.throwOnFetch;
      async function* throwingGen(): AsyncGenerator<AccessLogColdRow> {
        throw err;
        yield undefined as never;
      }
      return throwingGen();
    }
    const seed = opts.rows ?? [];
    async function* gen(): AsyncGenerator<AccessLogColdRow> {
      for (const r of seed) yield r;
    }
    return gen();
  });
  return { coldStore: { fetchRange } as unknown as ColdStore, fetchRange };
}

/**
 * Mock Kysely just enough that the chain in the hot SELECT branch
 * (`selectFrom → selectAll → orderBy → orderBy → limit → where* →
 * execute`) returns the supplied rows. Each `where(...)` returns the
 * same builder so an arbitrary number of optional filters can be
 * chained without specific stubs per filter.
 */
function makeHotMockDb(hotRows: AccessLogColdRow[]): {
  db: Kysely<Database>;
  execute: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn().mockResolvedValue(hotRows);
  const builder: Record<string, unknown> = {};
  builder.where = vi.fn(() => builder);
  builder.orderBy = vi.fn(() => builder);
  builder.limit = vi.fn(() => builder);
  builder.execute = execute;
  builder.selectAll = vi.fn(() => builder);
  const selectFrom = vi.fn(() => builder);
  return { db: { selectFrom } as unknown as Kysely<Database>, execute };
}

/**
 * For cold-resume calls the hot SELECT is skipped entirely, so no Kysely
 * methods are touched. Return a stub that throws if anything tries to
 * use it — that doubles as a guard that the cold-resume branch never
 * accidentally triggers the hot path.
 */
function makeUnusedDb(): Kysely<Database> {
  const guard: ProxyHandler<object> = {
    get(_, prop) {
      throw new Error(`hot DB method should not be called in cold-resume mode: ${String(prop)}`);
    },
  };
  return new Proxy({}, guard) as Kysely<Database>;
}

describe('loadAccessLogRange cold-store error propagation', () => {
  it('throws when cursor.source === "cold" and coldStore.fetchRange fails', async () => {
    const { coldStore, fetchRange } = makeColdStoreMock({
      throwOnFetch: new Error('S3 outage'),
    });

    await expect(
      loadAccessLogRange({
        db: makeUnusedDb(),
        coldStore,
        filter: { orgId: 'org-1' },
        limit: 50,
        cursor: buildColdCursorForId(COLD_DAY_2, 'cold-2'),
      }),
    ).rejects.toThrow('S3 outage');

    // The cold scan was attempted exactly once for the requested tenant.
    expect(fetchRange).toHaveBeenCalledTimes(1);
    const callArg = fetchRange.mock.calls[0][0] as { tenantId: string; table: string };
    expect(callArg).toMatchObject({ table: 'access_log', tenantId: 'org-1' });
  });

  it('returns hot rows with a soft-fallback warning when coldStore fails in mixed mode', async () => {
    // Hot returns fewer than `limit` rows AND fromTimestamp is older
    // than the 30-day warm cutoff, so loadAccessLogRange descends into
    // cold. The cold side throws — caller should get the hot rows back
    // with nextCursor=null (hot didn't fill the page).
    const HOT_ROW: AccessLogColdRow = {
      ...SAMPLE_COLD_1,
      id: 'hot-1',
      created_at: new Date(),
    } as AccessLogColdRow;
    const { db } = makeHotMockDb([HOT_ROW]);
    const { coldStore, fetchRange } = makeColdStoreMock({
      throwOnFetch: new Error('S3 outage'),
    });

    const result = await loadAccessLogRange({
      db,
      coldStore,
      filter: { orgId: 'org-1', fromTimestamp: COLD_DAY },
      limit: 50,
      // No cursor → cursor.source is null/undefined → mixed (first-page) mode.
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('hot-1');
    // Hot returned only one row (less than limit) so there's no hot-next-page.
    expect(result.nextCursor).toBeNull();
    expect(fetchRange).toHaveBeenCalledTimes(1);
  });

  it('returns cold rows when cursor.source === "cold" and the cold scan succeeds (regression guard)', async () => {
    // Happy path for the cold-resume branch — protects the existing
    // functionality the bug fix's catch-block branch must not break.
    const { coldStore, fetchRange } = makeColdStoreMock({
      rows: [SAMPLE_COLD_2, SAMPLE_COLD_1],
    });

    const result = await loadAccessLogRange({
      db: makeUnusedDb(),
      coldStore,
      filter: { orgId: 'org-1' },
      limit: 50,
      cursor: buildColdCursorForId(new Date('2026-02-01T00:00:00.000Z'), 'sentinel'),
    });

    // Both cold rows precede the sentinel cursor, so both come back
    // (sorted desc by created_at, id).
    expect(result.items.map((i) => i.id)).toEqual(['cold-2', 'cold-1']);
    // Page wasn't filled to limit → no further cursor.
    expect(result.nextCursor).toBeNull();
    expect(fetchRange).toHaveBeenCalledTimes(1);
  });
});
