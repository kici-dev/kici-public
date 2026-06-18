import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createOrgSettingsRoutes } from './admin-org-settings.js';
import { RbacEnforcer } from '../secrets/rbac.js';
import type { AccessLogRecord, AccessLogWriter } from '../audit/access-log.js';

vi.mock('../policy/dashboard-write-policy.js', () => ({
  getDashboardWritePolicy: vi.fn(),
  setDashboardWritePolicy: vi.fn(),
  resetDashboardWritePolicy: vi.fn(),
}));

import {
  getDashboardWritePolicy,
  setDashboardWritePolicy,
  resetDashboardWritePolicy,
} from '../policy/dashboard-write-policy.js';

interface AccessLogStub {
  writer: Pick<AccessLogWriter, 'record'>;
  records: AccessLogRecord[];
}

function makeAccessLogStub(): AccessLogStub {
  const records: AccessLogRecord[] = [];
  return {
    writer: {
      record: async (entry: AccessLogRecord) => {
        records.push(entry);
      },
    },
    records,
  };
}

function buildTestApp(opts?: { accessLog?: Pick<AccessLogWriter, 'record'> }) {
  const inner = createOrgSettingsRoutes({
    db: {} as never,
    rbac: new RbacEnforcer(),
    accessLog: opts?.accessLog as AccessLogWriter | undefined,
  });
  const root = new Hono();
  root.use('*', async (c, next) => {
    c.set('role' as never, 'admin' as never);
    c.set('userId' as never, 'tester' as never);
    c.set('routingKey' as never, null as never);
    await next();
  });
  root.route('/', inner);
  return root;
}

/**
 * Minimal stateful Kysely stub for the `org_settings` global-workflows path.
 * Records a single row per customer_id and mimics the exact query chain the
 * route uses: selectFrom().selectAll().where().executeTakeFirst() for reads and
 * insertInto().values().onConflict(...).execute() for upserts.
 */
function makeOrgSettingsDbStub() {
  const rows = new Map<string, Record<string, unknown>>();
  const db = {
    selectFrom() {
      let cid = '';
      const builder = {
        selectAll() {
          return builder;
        },
        select() {
          return builder;
        },
        where(_col: string, _op: string, val: string) {
          cid = val;
          return builder;
        },
        async executeTakeFirst() {
          return rows.get(cid);
        },
      };
      return builder;
    },
    insertInto() {
      let pending: Record<string, unknown> = {};
      const builder = {
        values(v: Record<string, unknown>) {
          pending = { ...v };
          return builder;
        },
        onConflict(cb: (oc: unknown) => unknown) {
          const oc = {
            column() {
              return oc;
            },
            doUpdateSet(set: Record<string, unknown>) {
              pending = { ...pending, ...set };
              return oc;
            },
          };
          cb(oc);
          return builder;
        },
        async execute() {
          const cid = pending.customer_id as string;
          const prev = rows.get(cid) ?? { created_at: new Date(), updated_at: new Date() };
          // Strip the sql`now()` marker; the stub doesn't evaluate it.
          const merged = { ...prev, ...pending };
          delete (merged as Record<string, unknown>).updated_at;
          rows.set(cid, { ...merged, created_at: prev.created_at, updated_at: new Date() });
        },
      };
      return builder;
    },
  };
  return { db, rows };
}

describe('org-settings/global-workflows — user-cache quota + TTL', () => {
  function buildWithDb(db: unknown) {
    const inner = createOrgSettingsRoutes({ db: db as never, rbac: new RbacEnforcer() });
    const root = new Hono();
    root.use('*', async (c, next) => {
      c.set('role' as never, 'admin' as never);
      c.set('userId' as never, 'tester' as never);
      c.set('routingKey' as never, null as never);
      await next();
    });
    root.route('/', inner);
    return root;
  }

  it('GET projects user-cache quota/TTL as null when the org row is absent', async () => {
    const { db } = makeOrgSettingsDbStub();
    const app = buildWithDb(db);
    const res = await app.request('/org-settings/global-workflows?customerId=kiciStg00001');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { settings: Record<string, unknown> };
    expect(body.settings.userCacheQuotaBytes).toBeNull();
    expect(body.settings.userCacheTtlMs).toBeNull();
  });

  it('PATCH sets a per-org quota + TTL and GET reads them back (bigint string → number)', async () => {
    const { db, rows } = makeOrgSettingsDbStub();
    const app = buildWithDb(db);
    const patch = await app.request('/org-settings/global-workflows', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerId: 'kiciStg00001',
        userCacheQuotaBytes: 1073741824,
        userCacheTtlMs: 3600000,
      }),
    });
    expect(patch.status).toBe(200);
    // Simulate pg returning BIGINT columns as strings on the next read.
    const stored = rows.get('kiciStg00001')!;
    stored.user_cache_quota_bytes = String(stored.user_cache_quota_bytes);
    stored.user_cache_ttl_ms = String(stored.user_cache_ttl_ms);
    const get = await app.request('/org-settings/global-workflows?customerId=kiciStg00001');
    const body = (await get.json()) as { settings: Record<string, unknown> };
    expect(body.settings.userCacheQuotaBytes).toBe(1073741824);
    expect(body.settings.userCacheTtlMs).toBe(3600000);
  });

  it('PATCH null clears a previously-set per-org override', async () => {
    const { db, rows } = makeOrgSettingsDbStub();
    const app = buildWithDb(db);
    await app.request('/org-settings/global-workflows', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerId: 'kiciStg00001', userCacheQuotaBytes: 999 }),
    });
    await app.request('/org-settings/global-workflows', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerId: 'kiciStg00001', userCacheQuotaBytes: null }),
    });
    expect(rows.get('kiciStg00001')!.user_cache_quota_bytes).toBeNull();
  });

  it('PATCH rejects a non-positive quota (Zod)', async () => {
    const { db } = makeOrgSettingsDbStub();
    const app = buildWithDb(db);
    const res = await app.request('/org-settings/global-workflows', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerId: 'kiciStg00001', userCacheQuotaBytes: -5 }),
    });
    expect(res.status).toBe(400);
  });

  it('GET projects dispatchAckTimeoutMs as null when the org row is absent', async () => {
    const { db } = makeOrgSettingsDbStub();
    const app = buildWithDb(db);
    const res = await app.request('/org-settings/global-workflows?customerId=kiciStg00001');
    const body = (await res.json()) as { settings: Record<string, unknown> };
    expect(body.settings.dispatchAckTimeoutMs).toBeNull();
  });

  it('PATCH sets dispatchAckTimeoutMs and GET reads it back (bigint string → number)', async () => {
    const { db, rows } = makeOrgSettingsDbStub();
    const app = buildWithDb(db);
    const patch = await app.request('/org-settings/global-workflows', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerId: 'kiciStg00001', dispatchAckTimeoutMs: 3000 }),
    });
    expect(patch.status).toBe(200);
    // Simulate pg returning the BIGINT column as a string on the next read.
    const stored = rows.get('kiciStg00001')!;
    stored.dispatch_ack_timeout_ms = String(stored.dispatch_ack_timeout_ms);
    const get = await app.request('/org-settings/global-workflows?customerId=kiciStg00001');
    const body = (await get.json()) as { settings: Record<string, unknown> };
    expect(body.settings.dispatchAckTimeoutMs).toBe(3000);
  });

  it('PATCH null clears a previously-set dispatchAckTimeoutMs override', async () => {
    const { db, rows } = makeOrgSettingsDbStub();
    const app = buildWithDb(db);
    await app.request('/org-settings/global-workflows', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerId: 'kiciStg00001', dispatchAckTimeoutMs: 5000 }),
    });
    await app.request('/org-settings/global-workflows', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerId: 'kiciStg00001', dispatchAckTimeoutMs: null }),
    });
    expect(rows.get('kiciStg00001')!.dispatch_ack_timeout_ms).toBeNull();
  });

  it('PATCH rejects a dispatchAckTimeoutMs below the 1000ms floor (Zod)', async () => {
    const { db } = makeOrgSettingsDbStub();
    const app = buildWithDb(db);
    const res = await app.request('/org-settings/global-workflows', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerId: 'kiciStg00001', dispatchAckTimeoutMs: 500 }),
    });
    expect(res.status).toBe(400);
  });

  it('GET projects the approval defaults (86400s, self-approval true) when no row exists', async () => {
    const { db } = makeOrgSettingsDbStub();
    const app = buildWithDb(db);
    const res = await app.request('/org-settings/global-workflows?customerId=kiciStg00001');
    const body = (await res.json()) as { settings: Record<string, unknown> };
    expect(body.settings.approvalExpirySeconds).toBe(86400);
    expect(body.settings.allowSelfApproval).toBe(true);
  });

  it('PATCH sets approvalExpirySeconds + allowSelfApproval and GET reads them back', async () => {
    const { db } = makeOrgSettingsDbStub();
    const app = buildWithDb(db);
    const patch = await app.request('/org-settings/global-workflows', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerId: 'kiciStg00001',
        approvalExpirySeconds: 3600,
        allowSelfApproval: false,
      }),
    });
    expect(patch.status).toBe(200);
    const get = await app.request('/org-settings/global-workflows?customerId=kiciStg00001');
    const body = (await get.json()) as { settings: Record<string, unknown> };
    expect(body.settings.approvalExpirySeconds).toBe(3600);
    expect(body.settings.allowSelfApproval).toBe(false);
  });

  it('PATCH rejects a non-positive approvalExpirySeconds (Zod floor)', async () => {
    const { db } = makeOrgSettingsDbStub();
    const app = buildWithDb(db);
    const res = await app.request('/org-settings/global-workflows', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerId: 'kiciStg00001', approvalExpirySeconds: 0 }),
    });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /org-settings/dashboard-writes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDashboardWritePolicy).mockResolvedValue({});
    vi.mocked(setDashboardWritePolicy).mockImplementation(async (_db, _id, updates) => updates);
    vi.mocked(resetDashboardWritePolicy).mockResolvedValue({});
  });

  it('accepts {customerId, reset: true} alone — Zod default empty-updates does not synthesise a conflict', async () => {
    const app = buildTestApp();
    const res = await app.request('/org-settings/dashboard-writes', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerId: 'kiciStg00001', reset: true }),
    });
    expect(res.status).toBe(200);
    expect(resetDashboardWritePolicy).toHaveBeenCalledOnce();
    expect(setDashboardWritePolicy).not.toHaveBeenCalled();
  });

  it('accepts {customerId, updates: {...}} alone', async () => {
    const app = buildTestApp();
    const res = await app.request('/org-settings/dashboard-writes', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerId: 'kiciStg00001',
        updates: { 'secrets.set': false },
      }),
    });
    expect(res.status).toBe(200);
    expect(setDashboardWritePolicy).toHaveBeenCalledOnce();
    expect(resetDashboardWritePolicy).not.toHaveBeenCalled();
  });

  it('rejects {customerId, updates: {non-empty}, reset: true} with 400', async () => {
    const app = buildTestApp();
    const res = await app.request('/org-settings/dashboard-writes', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerId: 'kiciStg00001',
        updates: { 'secrets.set': false },
        reset: true,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Provide either updates or reset, not both.');
    expect(setDashboardWritePolicy).not.toHaveBeenCalled();
    expect(resetDashboardWritePolicy).not.toHaveBeenCalled();
  });

  it('accepts {customerId, updates: {}, reset: true} — empty updates is not a conflict', async () => {
    const app = buildTestApp();
    const res = await app.request('/org-settings/dashboard-writes', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerId: 'kiciStg00001',
        updates: {},
        reset: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(resetDashboardWritePolicy).toHaveBeenCalledOnce();
  });

  it('rejects payload with an unknown operation name (Zod schema rejection)', async () => {
    const app = buildTestApp();
    const res = await app.request('/org-settings/dashboard-writes', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerId: 'kiciStg00001',
        updates: { 'unknown.op': false },
      }),
    });
    expect(res.status).toBe(400);
    expect(setDashboardWritePolicy).not.toHaveBeenCalled();
  });
});

describe('PATCH /org-settings/dashboard-writes — access_log audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDashboardWritePolicy).mockResolvedValue({});
    // Simulate the real helper firing onChange once per flipped op so the
    // route's callback runs against the AccessLogWriter spy.
    vi.mocked(setDashboardWritePolicy).mockImplementation(
      async (_db, customerId, updates, options) => {
        for (const [op, value] of Object.entries(updates) as Array<[string, boolean]>) {
          await options.onChange?.({
            actor: options.actor,
            customerId,
            op: op as never,
            prior: true,
            next: value,
          });
        }
        return updates;
      },
    );
    vi.mocked(resetDashboardWritePolicy).mockImplementation(async (_db, customerId, options) => {
      // Pretend two ops were disabled and are now being flipped back on.
      const reverted = ['secrets.set', 'variables.set'] as const;
      for (const op of reverted) {
        await options.onChange?.({
          actor: options.actor,
          customerId,
          op,
          prior: false,
          next: true,
        });
      }
      return {};
    });
  });

  it('writes one access_log row per flipped op on update', async () => {
    const stub = makeAccessLogStub();
    const app = buildTestApp({ accessLog: stub.writer });
    const res = await app.request('/org-settings/dashboard-writes', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerId: 'kiciStg00001',
        updates: { 'secrets.set': false, 'variables.set': false },
      }),
    });
    expect(res.status).toBe(200);
    expect(stub.records).toHaveLength(2);
    for (const row of stub.records) {
      expect(row.action).toBe('org_settings.dashboard_write_policy.update');
      expect(row.target).toEqual({ type: 'org_settings', id: 'kiciStg00001' });
      expect(row.source).toBe('admin_http');
      expect(row.outcome).toBe('allowed');
      expect(row.orgId).toBe('kiciStg00001');
      expect(row.actor).toEqual({ type: 'service_account', id: 'tester' });
      expect(row.meta?.prior_state).toBe(true);
      expect(row.meta?.new_state).toBe(false);
      expect(row.meta?.reset).toBeUndefined();
    }
    expect(stub.records.map((r) => r.meta?.operation).sort()).toEqual([
      'secrets.set',
      'variables.set',
    ]);
  });

  it('stamps reset:true in meta on reset calls', async () => {
    const stub = makeAccessLogStub();
    const app = buildTestApp({ accessLog: stub.writer });
    const res = await app.request('/org-settings/dashboard-writes', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerId: 'kiciStg00001', reset: true }),
    });
    expect(res.status).toBe(200);
    expect(stub.records).toHaveLength(2);
    for (const row of stub.records) {
      expect(row.meta?.reset).toBe(true);
      expect(row.meta?.prior_state).toBe(false);
      expect(row.meta?.new_state).toBe(true);
    }
  });

  it('runs without an AccessLogWriter — the mutation still succeeds', async () => {
    const app = buildTestApp({ accessLog: undefined });
    const res = await app.request('/org-settings/dashboard-writes', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerId: 'kiciStg00001',
        updates: { 'secrets.set': false },
      }),
    });
    expect(res.status).toBe(200);
  });
});
