import { describe, it, expect, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { ColdStore } from '@kici-dev/shared';
import { loadSecretAuditLogRange, type SecretAuditLogRow } from './load-secret-audit-log-range.js';
import type { Database } from '../db/types.js';

/**
 * Direct unit tests for `loadSecretAuditLogRange`. The
 * `AuditLogger.query()` wrapper at `packages/orchestrator/src/secrets/
 * audit-logger.ts` had no direct coverage of the cold-store error
 * branch — that gap mirrors the access-log gap that hid the
 * silent-data-loss bug fixed in `load-access-log-range.ts`.
 */

const COLD_DAY = new Date('2026-01-01T00:00:00.000Z'); // older than warm cutoff

const SAMPLE_COLD_1: SecretAuditLogRow = {
  id: 'cold-1',
  timestamp: COLD_DAY,
  action: 'getSecrets',
  context_name: 'ctx-a',
  routing_key: 'github:1',
  secret_keys: null,
  outcome: 'allowed',
  run_id: null,
  job_id: null,
  user_id: null,
  role: null,
  metadata: null,
  archived_at: null,
  archive_object_key: null,
} as unknown as SecretAuditLogRow;

const SAMPLE_HOT_1: SecretAuditLogRow = {
  ...SAMPLE_COLD_1,
  id: 'hot-1',
  timestamp: new Date(),
} as SecretAuditLogRow;

function makeColdStoreMock(opts: { rows?: SecretAuditLogRow[]; throwOnFetch?: Error }): {
  coldStore: ColdStore;
  fetchRange: ReturnType<typeof vi.fn>;
} {
  const fetchRange = vi.fn(() => {
    if (opts.throwOnFetch) {
      const err = opts.throwOnFetch;
      async function* throwingGen(): AsyncGenerator<SecretAuditLogRow> {
        throw err;
        yield undefined as never;
      }
      return throwingGen();
    }
    const seed = opts.rows ?? [];
    async function* gen(): AsyncGenerator<SecretAuditLogRow> {
      for (const r of seed) yield r;
    }
    return gen();
  });
  return { coldStore: { fetchRange } as unknown as ColdStore, fetchRange };
}

/**
 * Mock the two Kysely queries `loadSecretAuditLogRange` issues:
 *   - main hot SELECT: `selectFrom → selectAll → orderBy → where* →
 *     limit → offset → execute` (returns hotRows).
 *   - hot-count: `selectFrom → select → where* → executeTakeFirst`
 *     (returns `{ n: <total> }`).
 *
 * The two queries share the same `selectFrom` builder mock; differentiation
 * happens through which terminal method the helper calls (`.execute()` vs
 * `.executeTakeFirst()`).
 */
function makeMockDb(hotRows: SecretAuditLogRow[], hotCount: number): Kysely<Database> {
  const builder: Record<string, unknown> = {};
  builder.selectAll = vi.fn(() => builder);
  builder.select = vi.fn(() => builder);
  builder.where = vi.fn(() => builder);
  builder.orderBy = vi.fn(() => builder);
  builder.limit = vi.fn(() => builder);
  builder.offset = vi.fn(() => builder);
  builder.execute = vi.fn().mockResolvedValue(hotRows);
  builder.executeTakeFirst = vi.fn().mockResolvedValue({ n: String(hotCount) });
  const selectFrom = vi.fn(() => builder);
  return { selectFrom } as unknown as Kysely<Database>;
}

describe('loadSecretAuditLogRange cold-store error propagation', () => {
  it('throws when hotRows is empty (offset past hot tail) and coldStore fails', async () => {
    // offset > hotCount → hotRows = [], cold becomes the only source.
    const { coldStore, fetchRange } = makeColdStoreMock({
      throwOnFetch: new Error('S3 outage'),
    });

    await expect(
      loadSecretAuditLogRange({
        db: makeMockDb([], 5),
        coldStore,
        routingKey: 'github:1',
        limit: 50,
        offset: 100,
        includeArchived: true,
      }),
    ).rejects.toThrow('S3 outage');

    expect(fetchRange).toHaveBeenCalledTimes(1);
    const callArg = fetchRange.mock.calls[0][0] as { tenantId: string; table: string };
    expect(callArg).toMatchObject({ table: 'secret_audit_log', tenantId: 'github:1' });
  });

  it('returns hot rows with a soft-fallback warning when coldStore fails in mixed mode', async () => {
    // Hot has rows AND remaining capacity (limit > hotRows.length) so
    // the cold path runs; cold throws → return the hot rows we already
    // have. Partial data is honest in this branch.
    const { coldStore, fetchRange } = makeColdStoreMock({
      throwOnFetch: new Error('S3 outage'),
    });

    const result = await loadSecretAuditLogRange({
      db: makeMockDb([SAMPLE_HOT_1], 1),
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
    // Happy path for the cold-only branch — protects the existing
    // functionality the bug fix's catch-block branch must not break.
    // offset=0 + hotCount=0 keeps coldOffset=0 so the cold slice is
    // not pre-trimmed.
    const { coldStore, fetchRange } = makeColdStoreMock({ rows: [SAMPLE_COLD_1] });

    const result = await loadSecretAuditLogRange({
      db: makeMockDb([], 0),
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
