import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createClusterSettingsRoutes } from './admin-cluster-settings.js';
import { RbacEnforcer } from '../secrets/rbac.js';

/**
 * Minimal stateful Kysely stub for the single-row `cluster_settings` path.
 * Records one row keyed by id='default' and mimics the exact query chain the
 * route uses: selectFrom().selectAll().where().executeTakeFirst() for reads and
 * insertInto().values().onConflict(...).execute() for the upsert.
 */
function makeClusterSettingsDbStub() {
  const rows = new Map<string, Record<string, unknown>>();
  const db = {
    selectFrom() {
      let id = '';
      const builder = {
        selectAll() {
          return builder;
        },
        where(_col: string, _op: string, val: string) {
          id = val;
          return builder;
        },
        async executeTakeFirst() {
          return rows.get(id);
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
          const id = (pending.id as string) ?? 'default';
          const prev = rows.get(id) ?? {};
          const merged = { ...prev, ...pending };
          delete (merged as Record<string, unknown>).updated_at;
          rows.set(id, merged);
        },
      };
      return builder;
    },
  };
  return { db, rows };
}

function buildApp(db: unknown) {
  const inner = createClusterSettingsRoutes({ db: db as never, rbac: new RbacEnforcer() });
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

describe('admin cluster-settings route', () => {
  it('GET projects every knob as null when the row is absent', async () => {
    const { db } = makeClusterSettingsDbStub();
    const app = buildApp(db);
    const res = await app.request('/cluster-settings');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { settings: Record<string, unknown> };
    expect(body.settings.queueMaxDepth).toBeNull();
    expect(body.settings.webhookDedupTtlMs).toBeNull();
    expect(body.settings.maxGithubPayloadBytes).toBeNull();
  });

  it('PATCH sets a knob and GET reads it back', async () => {
    const { db } = makeClusterSettingsDbStub();
    const app = buildApp(db);
    const patch = await app.request('/cluster-settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queueMaxDepth: 42, webhookDedupTtlMs: 3_600_000 }),
    });
    expect(patch.status).toBe(200);
    const get = await app.request('/cluster-settings');
    const body = (await get.json()) as { settings: Record<string, unknown> };
    expect(body.settings.queueMaxDepth).toBe(42);
    expect(body.settings.webhookDedupTtlMs).toBe(3_600_000);
  });

  it('round-trips the six new fleet tunables through the generic COLUMNS chain', async () => {
    const { db } = makeClusterSettingsDbStub();
    const app = buildApp(db);
    const patchBody = {
      rerouteFlapGraceMs: 45_000,
      maxFanoutHosts: 8,
      eventRouterRateLimitPerWorkflowPerMinute: 250,
      cacheMaxTarballBytes: 1_048_576,
      cacheTtlDays: 14,
      concurrencyWaitTimeoutMs: 900_000,
      agentTokenTtlMs: 1_800_000,
    };
    const patch = await app.request('/cluster-settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patchBody),
    });
    expect(patch.status).toBe(200);
    const get = await app.request('/cluster-settings');
    const body = (await get.json()) as { settings: Record<string, unknown> };
    for (const [k, v] of Object.entries(patchBody)) {
      expect(body.settings[k]).toBe(v);
    }
  });

  it('coerces a bigint string column back to a number on GET', async () => {
    const { db, rows } = makeClusterSettingsDbStub();
    const app = buildApp(db);
    await app.request('/cluster-settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookDedupTtlMs: 3_600_000 }),
    });
    // Simulate pg returning the BIGINT column as a string on the next read.
    rows.get('default')!.webhook_dedup_ttl_ms = String(rows.get('default')!.webhook_dedup_ttl_ms);
    const get = await app.request('/cluster-settings');
    const body = (await get.json()) as { settings: Record<string, unknown> };
    expect(body.settings.webhookDedupTtlMs).toBe(3_600_000);
  });

  it('PATCH null clears a previously-set override', async () => {
    const { db, rows } = makeClusterSettingsDbStub();
    const app = buildApp(db);
    await app.request('/cluster-settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queueMaxDepth: 42 }),
    });
    await app.request('/cluster-settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queueMaxDepth: null }),
    });
    expect(rows.get('default')!.queue_max_depth).toBeNull();
  });

  it('PATCH leaves an unmentioned knob untouched', async () => {
    const { db } = makeClusterSettingsDbStub();
    const app = buildApp(db);
    await app.request('/cluster-settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queueMaxDepth: 42 }),
    });
    await app.request('/cluster-settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventRouterMaxDispatchAttempts: 7 }),
    });
    const get = await app.request('/cluster-settings');
    const body = (await get.json()) as { settings: Record<string, unknown> };
    expect(body.settings.queueMaxDepth).toBe(42);
    expect(body.settings.eventRouterMaxDispatchAttempts).toBe(7);
  });

  it('PATCH rejects a webhookDedupTtlMs below the 1000ms floor (Zod)', async () => {
    const { db } = makeClusterSettingsDbStub();
    const app = buildApp(db);
    const res = await app.request('/cluster-settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookDedupTtlMs: 500 }),
    });
    expect(res.status).toBe(400);
  });

  it('PATCH bumps version on a real settings change', async () => {
    const { db, rows } = makeClusterSettingsDbStub();
    const app = buildApp(db);
    // First real change: version 0 → 1.
    await app.request('/cluster-settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentTokenTtlMs: 1_800_000 }),
    });
    expect(Number(rows.get('default')?.version)).toBe(1);
    // A second, distinct change: version 1 → 2.
    await app.request('/cluster-settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentTokenTtlMs: 900_000 }),
    });
    expect(Number(rows.get('default')?.version)).toBe(2);
  });

  it('PATCH does NOT bump version on a no-op (empty body or unchanged value)', async () => {
    const { db, rows } = makeClusterSettingsDbStub();
    const app = buildApp(db);
    await app.request('/cluster-settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentTokenTtlMs: 1_800_000 }),
    });
    expect(Number(rows.get('default')?.version)).toBe(1);
    // Empty body: no columns provided → no bump.
    await app.request('/cluster-settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(Number(rows.get('default')?.version)).toBe(1);
    // Same value re-submitted: no change → no bump.
    await app.request('/cluster-settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentTokenTtlMs: 1_800_000 }),
    });
    expect(Number(rows.get('default')?.version)).toBe(1);
  });

  it('round-trips checkRunTrackingTtlDays through PATCH and GET', async () => {
    const { db } = makeClusterSettingsDbStub();
    const app = buildApp(db);
    const patch = await app.request('/cluster-settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkRunTrackingTtlDays: 14 }),
    });
    expect(patch.status).toBe(200);
    const get = await app.request('/cluster-settings');
    const body = (await get.json()) as { settings: Record<string, unknown> };
    expect(body.settings.checkRunTrackingTtlDays).toBe(14);
  });

  it('accepts checkRunTrackingTtlDays = 0, the documented disable value', async () => {
    // Every other numeric knob floors at 1 or higher, so a copy-pasted
    // `.min(1)` would still pass the round-trip above while making the sweep
    // impossible to turn off. This is the assertion that catches it.
    const { db } = makeClusterSettingsDbStub();
    const app = buildApp(db);
    const patch = await app.request('/cluster-settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkRunTrackingTtlDays: 0 }),
    });
    expect(patch.status).toBe(200);
    const body = (await patch.json()) as { settings: Record<string, unknown> };
    expect(body.settings.checkRunTrackingTtlDays).toBe(0);
  });

  it('rejects a negative checkRunTrackingTtlDays', async () => {
    const { db } = makeClusterSettingsDbStub();
    const app = buildApp(db);
    const patch = await app.request('/cluster-settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkRunTrackingTtlDays: -1 }),
    });
    expect(patch.status).toBe(400);
  });
});
