import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import pg from 'pg';
import type { ActorPrincipal } from '@kici-dev/engine';
import type { ColdStore } from '@kici-dev/shared';
import { AccessLogWriter } from './access-log.js';
import type { Database } from '../db/types.js';
import type { AccessLogColdRow } from '../cold-store/load-access-log-range.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!DATABASE_URL)('AccessLogWriter', () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: DATABASE_URL }),
      }),
    });
    await db.deleteFrom('access_log').execute();
  });

  afterEach(async () => {
    await db.deleteFrom('access_log').execute();
    await db.destroy();
  });

  it('records a user read and queries it back', async () => {
    const writer = new AccessLogWriter(db);
    const actor: ActorPrincipal = { type: 'user', sub: 'zsub-alice' };

    await writer.record({
      orgId: 'org-1',
      routingKey: 'github:12345',
      actor,
      action: 'run.detail.read',
      target: { type: 'run', id: 'run-abc' },
      requestId: '00000000-0000-0000-0000-000000000001',
      source: 'platform_proxy',
      outcome: 'allowed',
    });

    const result = await writer.query({ orgId: 'org-1' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      actorType: 'user',
      actorId: 'zsub-alice',
      action: 'run.detail.read',
      targetType: 'run',
      targetId: 'run-abc',
      source: 'platform_proxy',
      outcome: 'allowed',
      actorMeta: null,
    });
    expect(result.nextCursor).toBeNull();
  });

  it('records a platform_operator actor with reason in actor_meta', async () => {
    const writer = new AccessLogWriter(db);
    const actor: ActorPrincipal = {
      type: 'platform_operator',
      sub: 'zsub-op',
      reason: 'ticket-1234',
    };

    await writer.record({
      orgId: 'org-1',
      routingKey: 'github:12345',
      actor,
      action: 'run.detail.read',
      target: { type: 'run', id: 'run-xyz' },
      requestId: null,
      source: 'platform_proxy',
      outcome: 'allowed',
    });

    const [row] = (await writer.query({ orgId: 'org-1' })).items;
    expect(row.actorType).toBe('platform_operator');
    expect(row.actorId).toBe('zsub-op');
    expect(row.actorMeta).toEqual({ reason: 'ticket-1234' });
  });

  it('query filters by actor_type + action + source', async () => {
    const writer = new AccessLogWriter(db);
    await writer.record({
      orgId: 'org-1',
      routingKey: null,
      actor: { type: 'user', sub: 'u1' },
      action: 'run.detail.read',
      target: null,
      requestId: null,
      source: 'platform_proxy',
      outcome: 'allowed',
    });
    await writer.record({
      orgId: 'org-1',
      routingKey: null,
      actor: { type: 'api_key', keyId: 'ak1', ownerSub: 'u2' },
      action: 'run.cancel',
      target: null,
      requestId: null,
      source: 'admin_http',
      outcome: 'allowed',
    });

    const userOnly = await writer.query({ orgId: 'org-1', actorType: 'user' });
    expect(userOnly.items).toHaveLength(1);
    expect(userOnly.items[0].actorType).toBe('user');

    const cancelOnly = await writer.query({ orgId: 'org-1', action: 'run.cancel' });
    expect(cancelOnly.items).toHaveLength(1);
    expect(cancelOnly.items[0].action).toBe('run.cancel');
  });
});

describe('AccessLogWriter (mocked — failure swallow)', () => {
  it('swallows insert errors and logs instead of throwing', async () => {
    // Minimal Kysely-shape mock that throws on insertInto -> execute
    const db = {
      insertInto: vi.fn(() => ({
        values: vi.fn(() => ({
          execute: vi.fn().mockRejectedValue(new Error('fake db outage')),
        })),
      })),
    } as unknown as Kysely<Database>;

    const writer = new AccessLogWriter(db);
    // Use a `denied` outcome so the sampler is bypassed and the insert
    // path is actually exercised — the swallow contract is the focus
    // of this test.
    await expect(
      writer.record({
        orgId: 'org-1',
        routingKey: null,
        actor: { type: 'user', sub: 'u1' },
        action: 'run.detail.read',
        target: null,
        requestId: null,
        source: 'platform_proxy',
        outcome: 'denied',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('AccessLogWriter (mocked — best-effort contract)', () => {
  // Every caller uses `void this.accessLog.record(...)` (fire-and-forget),
  // so an unhandled rejection from any code path inside record() would
  // crash the orchestrator under Node's default rejection handling. The
  // class doc explicitly states this is a best-effort writer that MUST
  // NOT take down dashboard reads.

  it('swallows errors thrown by the rate limiter', async () => {
    // Limiter that throws — simulates a future limiter implementation
    // bug or a resource-constrained environment where the limiter's
    // backing store fails. Use a `rate_limit`-class action so the
    // limiter is consulted (allowed + non-platform_operator path).
    const db = {
      insertInto: vi.fn(() => ({
        values: vi.fn(() => ({ execute: vi.fn().mockResolvedValue(undefined) })),
      })),
    } as unknown as Kysely<Database>;
    const writer = new AccessLogWriter(db, undefined, {
      permit: () => {
        throw new Error('limiter exploded');
      },
    });
    await expect(
      writer.record({
        orgId: 'org-1',
        routingKey: null,
        actor: { type: 'user', sub: 'u1' },
        action: 'diagnostics.read',
        target: null,
        requestId: 'req-1',
        source: 'platform_proxy',
        outcome: 'allowed',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('AccessLogWriter (mocked — sampler integration)', () => {
  function makeMockDb() {
    const execute = vi.fn().mockResolvedValue(undefined);
    const db = {
      insertInto: vi.fn(() => ({
        values: vi.fn(() => ({ execute })),
      })),
    } as unknown as Kysely<Database>;
    return { db, execute };
  }

  it('drops a sampled-out allowed read', async () => {
    const { db, execute } = makeMockDb();
    // Limiter is unused for `sample` actions but required by the constructor.
    const writer = new AccessLogWriter(db, undefined, {
      permit: () => true,
    });
    let inserts = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) {
      await writer.record({
        orgId: 'org-1',
        routingKey: null,
        actor: { type: 'user', sub: `u-${i}` },
        action: 'run.detail.read',
        target: null,
        requestId: `req-${i}`,
        source: 'platform_proxy',
        outcome: 'allowed',
      });
    }
    inserts = execute.mock.calls.length;
    // 5% of 1000 = 50 ± reasonable noise.
    expect(inserts).toBeGreaterThan(20);
    expect(inserts).toBeLessThan(100);
  });

  it('always records denied outcomes regardless of policy', async () => {
    const { db, execute } = makeMockDb();
    const writer = new AccessLogWriter(db, undefined, {
      // NeverAllow: even rate-limit calls would drop. Denied bypasses both.
      permit: () => false,
    });
    for (let i = 0; i < 50; i++) {
      await writer.record({
        orgId: 'org-1',
        routingKey: null,
        actor: { type: 'user', sub: 'u1' },
        action: 'diagnostics.read',
        target: null,
        requestId: `req-${i}`,
        source: 'platform_proxy',
        outcome: 'denied',
      });
    }
    expect(execute.mock.calls.length).toBe(50);
  });

  it('always records platform_operator activity regardless of policy', async () => {
    const { db, execute } = makeMockDb();
    const writer = new AccessLogWriter(db, undefined, {
      permit: () => false,
    });
    for (let i = 0; i < 50; i++) {
      await writer.record({
        orgId: 'org-1',
        routingKey: null,
        actor: {
          type: 'platform_operator',
          sub: 'op-1',
          reason: 'incident XYZ-12345',
        },
        action: 'diagnostics.read',
        target: null,
        requestId: `req-${i}`,
        source: 'platform_proxy',
        outcome: 'allowed',
      });
    }
    expect(execute.mock.calls.length).toBe(50);
  });

  it('honours the rate limiter for diagnostics.read allowed reads', async () => {
    const { db, execute } = makeMockDb();
    let calls = 0;
    const writer = new AccessLogWriter(db, undefined, {
      permit: () => {
        calls++;
        return calls === 1;
      },
    });
    for (let i = 0; i < 5; i++) {
      await writer.record({
        orgId: 'org-1',
        routingKey: null,
        actor: { type: 'user', sub: 'u1' },
        action: 'diagnostics.read',
        target: null,
        requestId: `req-${i}`,
        source: 'platform_proxy',
        outcome: 'allowed',
      });
    }
    expect(execute.mock.calls.length).toBe(1);
  });
});

describe('AccessLogWriter.getById (cold-store fallback)', () => {
  // Mirrors the matrix specified by the wishlist plan: hot hit, hot miss
  // (with and without a cold-store wired), cold hit with `--org-id`, cold
  // hit without `--org-id` (synthetic tenant), cold miss, and cold-store
  // throws. The fallback exists because `query()` already merges hot+cold
  // via `loadAccessLogRange`, so paginated lists surface archived rows but
  // the legacy `getById` would 404 on the same ids.
  const SAMPLE_HOT = {
    id: 'hot-1',
    org_id: 'org-1',
    routing_key: 'github:1',
    actor_type: 'user',
    actor_id: 'u-hot',
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
    created_at: new Date('2026-04-01T00:00:00.000Z'),
  } as unknown as AccessLogColdRow;

  const SAMPLE_COLD = {
    ...SAMPLE_HOT,
    id: 'cold-1',
    actor_id: 'u-cold',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
  } as AccessLogColdRow;

  function makeSelectMockDb(rowToReturn: AccessLogColdRow | undefined) {
    const executeTakeFirst = vi.fn().mockResolvedValue(rowToReturn);
    const where = vi.fn(() => ({ executeTakeFirst }));
    const selectAll = vi.fn(() => ({ where }));
    const selectFrom = vi.fn(() => ({ selectAll }));
    return {
      db: { selectFrom } as unknown as Kysely<Database>,
      executeTakeFirst,
      selectFrom,
    };
  }

  function makeColdStoreMock(opts: { rows?: AccessLogColdRow[]; throwOnFetch?: Error }): {
    coldStore: ColdStore;
    fetchRange: ReturnType<typeof vi.fn>;
  } {
    const fetchRange = vi.fn((args: { tenantId: string }) => {
      if (opts.throwOnFetch) {
        async function* throwingGen(): AsyncGenerator<AccessLogColdRow> {
          throw opts.throwOnFetch;
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
    // The real ColdStore exposes more than fetchRange, but getById only
    // touches that one method — cast through unknown to satisfy the
    // structural interface without stubbing the rest.
    return { coldStore: { fetchRange } as unknown as ColdStore, fetchRange };
  }

  it('returns the hot row without consulting cold-store', async () => {
    const { db } = makeSelectMockDb(SAMPLE_HOT);
    const { coldStore, fetchRange } = makeColdStoreMock({});
    const writer = new AccessLogWriter(db, coldStore);

    const out = await writer.getById('hot-1', { orgId: 'org-1' });

    expect(out).not.toBeNull();
    expect(out?.id).toBe('hot-1');
    expect(out?.actorId).toBe('u-hot');
    expect(fetchRange).not.toHaveBeenCalled();
  });

  it('returns null on hot miss when no cold-store is wired', async () => {
    const { db } = makeSelectMockDb(undefined);
    const writer = new AccessLogWriter(db);
    const out = await writer.getById('missing-id', { orgId: 'org-1' });
    expect(out).toBeNull();
  });

  it('falls back to cold-store with the supplied orgId tenant', async () => {
    const { db } = makeSelectMockDb(undefined);
    const { coldStore, fetchRange } = makeColdStoreMock({ rows: [SAMPLE_COLD] });
    const writer = new AccessLogWriter(db, coldStore);

    const out = await writer.getById('cold-1', { orgId: 'org-1' });

    expect(out?.id).toBe('cold-1');
    expect(out?.actorId).toBe('u-cold');
    expect(fetchRange).toHaveBeenCalledTimes(1);
    const callArg = fetchRange.mock.calls[0][0] as { tenantId: string; table: string; db: string };
    expect(callArg).toMatchObject({
      db: 'orchestrator',
      table: 'access_log',
      tenantId: 'org-1',
    });
  });

  it('falls back to cold-store with the synthetic tenant when no orgId is given', async () => {
    const { db } = makeSelectMockDb(undefined);
    // The synthetic tenant scan emits NULL-org_id rows (orchestrator-level
    // events such as `archive_chunk`, `purge_chunk`).
    const syntheticRow = { ...SAMPLE_COLD, org_id: null, id: 'cold-synthetic' } as AccessLogColdRow;
    const { coldStore, fetchRange } = makeColdStoreMock({ rows: [syntheticRow] });
    const writer = new AccessLogWriter(db, coldStore);

    const out = await writer.getById('cold-synthetic');

    expect(out?.id).toBe('cold-synthetic');
    expect(out?.orgId).toBeNull();
    const callArg = fetchRange.mock.calls[0][0] as { tenantId: string };
    expect(callArg.tenantId).toBe('__orchestrator__');
  });

  it('returns null when neither hot nor cold has a matching row', async () => {
    const { db } = makeSelectMockDb(undefined);
    const otherCold = { ...SAMPLE_COLD, id: 'some-other-id' } as AccessLogColdRow;
    const { coldStore } = makeColdStoreMock({ rows: [otherCold] });
    const writer = new AccessLogWriter(db, coldStore);

    const out = await writer.getById('not-here', { orgId: 'org-1' });
    expect(out).toBeNull();
  });

  it('returns null and does not throw when cold-store fetchRange fails', async () => {
    const { db } = makeSelectMockDb(undefined);
    const { coldStore, fetchRange } = makeColdStoreMock({
      throwOnFetch: new Error('S3 outage'),
    });
    const writer = new AccessLogWriter(db, coldStore);

    // Best-effort contract: a transient cold-store error MUST NOT throw
    // out of getById, otherwise `kici-admin access-log show` and the
    // dashboard detail handler would surface a 500 instead of a normal
    // 404 fallthrough.
    const out = await writer.getById('cold-1', { orgId: 'org-1' });
    expect(out).toBeNull();
    expect(fetchRange).toHaveBeenCalledTimes(1);
  });
});
