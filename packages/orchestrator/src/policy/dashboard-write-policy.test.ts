import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Records every `sql` tagged-template the module issues, so the cross-peer
 * `pg_notify` can be asserted without a real Postgres executor (the fake db
 * below implements only the three Kysely builders the module uses).
 */
const rawQueries = vi.hoisted(
  () => [] as Array<{ text: string; values: unknown[]; executedOn: unknown }>,
);

vi.mock('kysely', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    sql: new Proxy(actual.sql as object, {
      apply(_target: unknown, _thisArg: unknown, args: unknown[]) {
        const strings = args[0] as TemplateStringsArray;
        const values = args.slice(1);
        return {
          execute: async (executedOn: unknown) => {
            rawQueries.push({ text: strings.join('?'), values, executedOn });
            return { rows: [] };
          },
        };
      },
    }),
  };
});

import {
  DASHBOARD_WRITE_POLICY_CHANNEL,
  DashboardWritePolicyDisabledError,
  assertDashboardWriteAllowed,
  dashboardWritePolicyEvents,
  getDashboardWritePolicy,
  invalidateDashboardWritePolicyCache,
  isDashboardWriteEnabled,
  resetDashboardWritePolicy,
  resolveFullPolicyView,
  setDashboardWritePolicy,
} from './dashboard-write-policy.js';
import {
  DASHBOARD_WRITE_OPERATION_VALUES,
  DashboardWritePolicyState,
} from '@kici-dev/engine/protocol/dashboard-write-operations';
import type { ActorPrincipal } from '@kici-dev/engine';

interface FakeRow {
  customer_id: string;
  dashboard_write_policy: Record<string, boolean>;
}

/**
 * Lightweight in-memory Kysely stand-in. The policy module only
 * touches `org_settings` via selectFrom + insertInto + transaction.
 * Faking those three call paths lets us cover every branch without
 * spinning up Postgres for a unit test.
 */
function makeFakeDb(initialRows: FakeRow[] = []) {
  const rows = new Map<string, Record<string, boolean>>();
  for (const row of initialRows) {
    rows.set(row.customer_id, { ...row.dashboard_write_policy });
  }

  const handle = {
    select(customerId: string) {
      const policy = rows.get(customerId);
      return policy === undefined ? undefined : { dashboard_write_policy: policy };
    },
    upsert(customerId: string, policy: Record<string, boolean>) {
      rows.set(customerId, { ...policy });
    },
    get(customerId: string) {
      return rows.get(customerId);
    },
    size: () => rows.size,
  };

  // The minimal Kysely surface we need.
  const db = {
    selectFrom() {
      let cap: string | undefined;
      return {
        select() {
          return this;
        },
        selectAll() {
          return this;
        },
        where(_col: string, _op: string, val: string) {
          cap = val;
          return this;
        },
        async executeTakeFirst() {
          return handle.select(cap!);
        },
      } as unknown as {
        select: () => unknown;
        selectAll: () => unknown;
        where: (col: string, op: string, val: string) => unknown;
        executeTakeFirst: () => Promise<unknown>;
      };
    },
    insertInto() {
      let pendingValues: { customer_id: string; dashboard_write_policy: string } | undefined;
      return {
        values(v: { customer_id: string; dashboard_write_policy: string }) {
          pendingValues = v;
          return this;
        },
        onConflict(
          cb: (oc: {
            column: (k: string) => {
              doUpdateSet: (u: { dashboard_write_policy: string }) => unknown;
            };
          }) => unknown,
        ) {
          // The callback updates the same row we already captured.
          cb({
            column: () => ({
              doUpdateSet: (u: { dashboard_write_policy: string }) => {
                pendingValues = {
                  customer_id: pendingValues!.customer_id,
                  dashboard_write_policy: u.dashboard_write_policy,
                };
                return this;
              },
            }),
          });
          return this;
        },
        async execute() {
          const parsed = JSON.parse(pendingValues!.dashboard_write_policy);
          handle.upsert(pendingValues!.customer_id, parsed);
        },
      };
    },
    transaction() {
      return {
        execute: async <T>(fn: (tx: typeof db) => Promise<T>) => fn(db),
      };
    },
  } as unknown as Parameters<typeof getDashboardWritePolicy>[0];

  return { db, handle };
}

const actor: ActorPrincipal = { type: 'user', sub: 'zit-12345' };

beforeEach(() => {
  invalidateDashboardWritePolicyCache();
  dashboardWritePolicyEvents.removeAllListeners();
  rawQueries.length = 0;
});

/** The `pg_notify` calls recorded during the current test, if any. */
function notifyCalls() {
  return rawQueries.filter((q) => q.text.includes('pg_notify'));
}

afterEach(() => {
  invalidateDashboardWritePolicyCache();
  dashboardWritePolicyEvents.removeAllListeners();
  vi.useRealTimers();
});

describe('getDashboardWritePolicy', () => {
  it('returns empty map when no row exists', async () => {
    const { db } = makeFakeDb();
    const policy = await getDashboardWritePolicy(db, 'customer-1');
    expect(policy).toEqual({});
  });

  it('returns the persisted policy for a known customer', async () => {
    const { db } = makeFakeDb([
      { customer_id: 'customer-1', dashboard_write_policy: { 'secrets.set': false } },
    ]);
    const policy = await getDashboardWritePolicy(db, 'customer-1');
    expect(policy).toEqual({ 'secrets.set': 'disabled' });
  });

  it('treats unparseable policy column as empty', async () => {
    const { db } = makeFakeDb([
      {
        customer_id: 'customer-1',
        dashboard_write_policy: { 'unknown.op': false } as unknown as Record<string, boolean>,
      },
    ]);
    const policy = await getDashboardWritePolicy(db, 'customer-1');
    expect(policy).toEqual({});
  });
});

describe('isDashboardWriteEnabled', () => {
  it('returns true for an unset operation (permissive default)', async () => {
    const { db } = makeFakeDb();
    expect(await isDashboardWriteEnabled(db, 'customer-1', 'secrets.set')).toBe(true);
  });

  it('returns false when explicitly disabled', async () => {
    const { db } = makeFakeDb([
      { customer_id: 'customer-1', dashboard_write_policy: { 'secrets.set': false } },
    ]);
    expect(await isDashboardWriteEnabled(db, 'customer-1', 'secrets.set')).toBe(false);
  });

  it('returns true for unrelated operations when one is disabled', async () => {
    const { db } = makeFakeDb([
      { customer_id: 'customer-1', dashboard_write_policy: { 'secrets.set': false } },
    ]);
    expect(await isDashboardWriteEnabled(db, 'customer-1', 'held_runs.approve')).toBe(true);
  });
});

describe('assertDashboardWriteAllowed', () => {
  it('resolves silently when the operation is enabled', async () => {
    const { db } = makeFakeDb();
    await expect(
      assertDashboardWriteAllowed(db, 'customer-1', 'secrets.set'),
    ).resolves.toBeUndefined();
  });

  it('throws DashboardWritePolicyDisabledError when disabled', async () => {
    const { db } = makeFakeDb([
      { customer_id: 'customer-1', dashboard_write_policy: { 'secrets.set': false } },
    ]);
    await expect(
      assertDashboardWriteAllowed(db, 'customer-1', 'secrets.set'),
    ).rejects.toBeInstanceOf(DashboardWritePolicyDisabledError);
  });

  it('error carries the operation + cliEquivalent hint', async () => {
    const { db } = makeFakeDb([
      { customer_id: 'customer-1', dashboard_write_policy: { 'secrets.set': false } },
    ]);
    try {
      await assertDashboardWriteAllowed(db, 'customer-1', 'secrets.set');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DashboardWritePolicyDisabledError);
      const policyErr = err as DashboardWritePolicyDisabledError;
      expect(policyErr.operation).toBe('secrets.set');
      expect(policyErr.cliEquivalent).toBe('kici-admin secret set');
      expect(policyErr.code).toBe('operation_disabled');
    }
  });
});

describe('setDashboardWritePolicy', () => {
  it('persists a disable change', async () => {
    const { db, handle } = makeFakeDb();
    await setDashboardWritePolicy(db, 'customer-1', { 'secrets.set': 'disabled' }, { actor });
    expect(handle.get('customer-1')).toEqual({ 'secrets.set': 'disabled' });
  });

  it('normalizes "true" away — permissive is the absence of a key', async () => {
    const { db, handle } = makeFakeDb([
      {
        customer_id: 'customer-1',
        dashboard_write_policy: { 'secrets.set': false, 'variables.set': false },
      },
    ]);
    await setDashboardWritePolicy(db, 'customer-1', { 'secrets.set': 'permissive' }, { actor });
    expect(handle.get('customer-1')).toEqual({ 'variables.set': 'disabled' });
  });

  it('rejects unknown operation keys via the engine schema', async () => {
    const { db } = makeFakeDb();
    await expect(
      setDashboardWritePolicy(
        db,
        'customer-1',
        { 'bogus.op': false } as unknown as Parameters<typeof setDashboardWritePolicy>[2],
        { actor },
      ),
    ).rejects.toThrow();
  });

  it('no-ops (no DB write, no audit, no event) when nothing changes', async () => {
    const { db, handle } = makeFakeDb([
      { customer_id: 'customer-1', dashboard_write_policy: { 'secrets.set': false } },
    ]);
    const onChange = vi.fn().mockResolvedValue(undefined);
    const eventSpy = vi.fn();
    dashboardWritePolicyEvents.on('changed', eventSpy);
    const beforeUpsert = handle.get('customer-1');
    await setDashboardWritePolicy(db, 'customer-1', { 'secrets.set': false }, { actor, onChange });
    expect(handle.get('customer-1')).toEqual(beforeUpsert);
    expect(onChange).not.toHaveBeenCalled();
    expect(eventSpy).not.toHaveBeenCalled();
  });

  it('invokes onChange once per flipped operation with actor + change details', async () => {
    const { db } = makeFakeDb();
    const onChange = vi.fn().mockResolvedValue(undefined);
    await setDashboardWritePolicy(
      db,
      'customer-1',
      { 'secrets.set': false, 'variables.set': false, 'held_runs.approve': false },
      { actor, onChange },
    );
    expect(onChange).toHaveBeenCalledTimes(3);
    const events = onChange.mock.calls.map((c) => c[0]);
    expect(events.map((e) => e.op).sort()).toEqual([
      'held_runs.approve',
      'secrets.set',
      'variables.set',
    ]);
    for (const ev of events) {
      expect(ev.actor).toEqual(actor);
      expect(ev.customerId).toBe('customer-1');
      expect(ev.prior).toBe('permissive');
      expect(ev.next).toBe('disabled');
    }
  });

  it('emits a "changed" event on the bus after a successful change', async () => {
    const { db } = makeFakeDb();
    const eventSpy = vi.fn();
    dashboardWritePolicyEvents.on('changed', eventSpy);
    await setDashboardWritePolicy(db, 'customer-1', { 'secrets.set': false }, { actor });
    expect(eventSpy).toHaveBeenCalledOnce();
    const arg = eventSpy.mock.calls[0]?.[0] as { customerId: string; policy: unknown };
    expect(arg.customerId).toBe('customer-1');
    expect(arg.policy).toEqual({ 'secrets.set': 'disabled' });
  });

  it('notifies the cluster channel from inside the write transaction', async () => {
    const { db } = makeFakeDb();
    await setDashboardWritePolicy(
      db,
      'customer-1',
      { 'secrets.set': DashboardWritePolicyState.enum.disabled },
      { actor },
    );
    const calls = notifyCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].values).toEqual([DASHBOARD_WRITE_POLICY_CHANNEL, 'customer-1']);
    // The fake transaction hands the same handle to its callback, so the
    // executor being that handle is what proves the NOTIFY rides the write's
    // transaction rather than a separate connection — Postgres then queues it
    // until commit, and a rolled-back write notifies nobody.
    expect(calls[0].executedOn).toBe(db);
  });

  it('does not notify when nothing changed', async () => {
    const { db } = makeFakeDb([
      { customer_id: 'customer-1', dashboard_write_policy: { 'secrets.set': false } },
    ]);
    await setDashboardWritePolicy(
      db,
      'customer-1',
      { 'secrets.set': DashboardWritePolicyState.enum.disabled },
      { actor },
    );
    expect(notifyCalls()).toHaveLength(0);
  });

  it('invalidates the cache so subsequent reads pick up the change', async () => {
    const { db } = makeFakeDb();
    await getDashboardWritePolicy(db, 'customer-1');
    await setDashboardWritePolicy(db, 'customer-1', { 'secrets.set': false }, { actor });
    expect(await getDashboardWritePolicy(db, 'customer-1')).toEqual({ 'secrets.set': 'disabled' });
  });
});

describe('resetDashboardWritePolicy', () => {
  it('clears all disabled flags', async () => {
    const { db, handle } = makeFakeDb([
      {
        customer_id: 'customer-1',
        dashboard_write_policy: { 'secrets.set': false, 'variables.set': false },
      },
    ]);
    const next = await resetDashboardWritePolicy(db, 'customer-1', { actor });
    expect(next).toEqual({});
    expect(handle.get('customer-1')).toEqual({});
  });

  it('no-ops when policy is already empty', async () => {
    const { db } = makeFakeDb();
    const eventSpy = vi.fn();
    dashboardWritePolicyEvents.on('changed', eventSpy);
    const result = await resetDashboardWritePolicy(db, 'customer-1', { actor });
    expect(result).toEqual({});
    expect(eventSpy).not.toHaveBeenCalled();
  });
});

describe('resolveFullPolicyView', () => {
  it('returns the full operation map with permissive defaults', () => {
    const view = resolveFullPolicyView({});
    expect(Object.keys(view).length).toBe(DASHBOARD_WRITE_OPERATION_VALUES.length);
    expect(new Set(Object.keys(view))).toEqual(new Set(DASHBOARD_WRITE_OPERATION_VALUES));
    for (const enabled of Object.values(view)) {
      expect(enabled).toBe(true);
    }
  });

  it('reflects disabled operations', () => {
    const view = resolveFullPolicyView({ 'secrets.set': 'disabled', 'variables.set': 'disabled' });
    expect(view['secrets.set']).toBe(false);
    expect(view['variables.set']).toBe(false);
    expect(view['secrets.delete']).toBe(true);
    expect(view['held_runs.approve']).toBe(true);
  });
});

describe('cache invalidation', () => {
  it('clears all entries when customerId is omitted', async () => {
    const { db } = makeFakeDb([
      { customer_id: 'c-a', dashboard_write_policy: { 'secrets.set': false } },
      { customer_id: 'c-b', dashboard_write_policy: { 'variables.set': false } },
    ]);
    await getDashboardWritePolicy(db, 'c-a');
    await getDashboardWritePolicy(db, 'c-b');
    invalidateDashboardWritePolicyCache();
    // Cache is empty — the next reads go to the fake DB.
    await getDashboardWritePolicy(db, 'c-a');
    await getDashboardWritePolicy(db, 'c-b');
    // No assert here beyond "no crash" — the fake DB returns the same shapes.
  });

  it('clears only one entry when customerId is specified', async () => {
    const { db } = makeFakeDb([
      { customer_id: 'c-a', dashboard_write_policy: { 'secrets.set': false } },
    ]);
    await getDashboardWritePolicy(db, 'c-a');
    invalidateDashboardWritePolicyCache('c-a');
    const refreshed = await getDashboardWritePolicy(db, 'c-a');
    expect(refreshed).toEqual({ 'secrets.set': 'disabled' });
  });
});
