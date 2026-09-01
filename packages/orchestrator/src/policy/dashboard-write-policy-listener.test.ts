/**
 * Tests for DashboardWritePolicyChangeListener — the cross-coordinator
 * propagation of `kici-admin` dashboard-write policy flips.
 *
 * The listener is what makes a policy change reach a coordinator that did
 * not serve the admin write: it drops that peer's cached map and re-emits
 * `'changed'` locally, which the platform-mode boot turns into a fresh
 * `orch.capabilities` broadcast.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DashboardWritePolicyChangeListener } from './dashboard-write-policy-listener.js';
import {
  DASHBOARD_WRITE_POLICY_CHANNEL,
  dashboardWritePolicyEvents,
  getDashboardWritePolicy,
  invalidateDashboardWritePolicyCache,
} from './dashboard-write-policy.js';
import { DashboardWritePolicyState } from '@kici-dev/engine/protocol/dashboard-write-operations';
import type { Database } from '../db/types.js';
import type { Kysely } from 'kysely';

function createMockPoolClient() {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
    }),
    _emit: (channel: string, payload?: string) => {
      for (const listener of listeners.get('notification') ?? []) {
        listener({ channel, payload });
      }
    },
  };
}

/**
 * Minimal Kysely stand-in over an in-memory `org_settings` map — the listener
 * only ever reads one column for one customer, through
 * `getDashboardWritePolicy`.
 */
function makeFakeDb(rows: Record<string, Record<string, string>>) {
  const reads: string[] = [];
  const db = {
    selectFrom() {
      let cap: string | undefined;
      return {
        select() {
          return this;
        },
        where(_col: string, _op: string, val: string) {
          cap = val;
          return this;
        },
        async executeTakeFirst() {
          reads.push(cap!);
          const policy = rows[cap!];
          return policy === undefined ? undefined : { dashboard_write_policy: policy };
        },
      };
    },
  } as unknown as Kysely<Database>;
  return { db, reads };
}

function makeListener(rows: Record<string, Record<string, string>>, debounceMs = 5) {
  const client = createMockPoolClient();
  const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as import('pg').Pool;
  const { db, reads } = makeFakeDb(rows);
  const listener = new DashboardWritePolicyChangeListener({ pool, db, debounceMs });
  return { listener, client, db, reads };
}

beforeEach(() => {
  vi.useFakeTimers();
  invalidateDashboardWritePolicyCache();
  dashboardWritePolicyEvents.removeAllListeners();
});

afterEach(() => {
  vi.useRealTimers();
  invalidateDashboardWritePolicyCache();
  dashboardWritePolicyEvents.removeAllListeners();
});

describe('DashboardWritePolicyChangeListener', () => {
  it(`LISTENs on ${DASHBOARD_WRITE_POLICY_CHANNEL} after start()`, async () => {
    const { listener, client } = makeListener({});
    await listener.start();
    expect(client.query).toHaveBeenCalledWith(`LISTEN ${DASHBOARD_WRITE_POLICY_CHANNEL}`);
    await listener.stop();
    expect(client.query).toHaveBeenCalledWith(`UNLISTEN ${DASHBOARD_WRITE_POLICY_CHANNEL}`);
    expect(client.release).toHaveBeenCalled();
  });

  it('ignores NOTIFYs on other channels', async () => {
    const { listener, client, reads } = makeListener({});
    await listener.start();
    client._emit('generic_sources_change', 'generic:org-1:src-1');
    await vi.advanceTimersByTimeAsync(10);
    expect(reads).toEqual([]);
    await listener.stop();
  });

  it('ignores a payload-less NOTIFY', async () => {
    const { listener, client, reads } = makeListener({});
    await listener.start();
    client._emit(DASHBOARD_WRITE_POLICY_CHANNEL);
    await vi.advanceTimersByTimeAsync(10);
    expect(reads).toEqual([]);
    await listener.stop();
  });

  it('drops the stale cached map and emits the freshly read one', async () => {
    const rows: Record<string, Record<string, string>> = { 'customer-1': {} };
    const { listener, client, db } = makeListener(rows);
    await listener.start();

    // Warm this peer's cache the way a dashboard.* request would, then flip
    // the policy underneath it — exactly what a sibling coordinator's admin
    // PATCH does to the shared database.
    expect(await getDashboardWritePolicy(db, 'customer-1')).toEqual({});
    rows['customer-1'] = { 'secrets.set': DashboardWritePolicyState.enum.disabled };

    const eventSpy = vi.fn();
    dashboardWritePolicyEvents.on('changed', eventSpy);
    client._emit(DASHBOARD_WRITE_POLICY_CHANNEL, 'customer-1');
    await vi.advanceTimersByTimeAsync(10);

    expect(eventSpy).toHaveBeenCalledOnce();
    expect(eventSpy.mock.calls[0][0]).toEqual({
      customerId: 'customer-1',
      policy: { 'secrets.set': DashboardWritePolicyState.enum.disabled },
    });
    // The local gate converges too, well inside the 30 s cache TTL it would
    // otherwise have kept serving `secrets.set` as permissive for.
    expect(await getDashboardWritePolicy(db, 'customer-1')).toEqual({
      'secrets.set': DashboardWritePolicyState.enum.disabled,
    });
    await listener.stop();
  });

  it('coalesces repeated NOTIFYs for one customer into a single drain', async () => {
    const { listener, client, reads } = makeListener({ 'customer-1': {} });
    await listener.start();
    const eventSpy = vi.fn();
    dashboardWritePolicyEvents.on('changed', eventSpy);

    client._emit(DASHBOARD_WRITE_POLICY_CHANNEL, 'customer-1');
    client._emit(DASHBOARD_WRITE_POLICY_CHANNEL, 'customer-1');
    client._emit(DASHBOARD_WRITE_POLICY_CHANNEL, 'customer-1');
    await vi.advanceTimersByTimeAsync(10);

    expect(reads).toEqual(['customer-1']);
    expect(eventSpy).toHaveBeenCalledOnce();
    await listener.stop();
  });

  it('applies every distinct customer in one drain pass', async () => {
    const { listener, client } = makeListener({
      'customer-1': { 'secrets.set': DashboardWritePolicyState.enum.disabled },
      'customer-2': { 'event_dlq.retry': DashboardWritePolicyState.enum.disabled },
    });
    await listener.start();
    const eventSpy = vi.fn();
    dashboardWritePolicyEvents.on('changed', eventSpy);

    client._emit(DASHBOARD_WRITE_POLICY_CHANNEL, 'customer-1');
    client._emit(DASHBOARD_WRITE_POLICY_CHANNEL, 'customer-2');
    await vi.advanceTimersByTimeAsync(10);

    expect(eventSpy).toHaveBeenCalledTimes(2);
    expect(eventSpy.mock.calls.map((c) => c[0].customerId).sort()).toEqual([
      'customer-1',
      'customer-2',
    ]);
    await listener.stop();
  });

  it('leaves the cache invalidated when the re-read fails', async () => {
    const client = createMockPoolClient();
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as import('pg').Pool;
    let fail = false;
    let stored: Record<string, string> = {};
    const db = {
      selectFrom() {
        return {
          select() {
            return this;
          },
          where() {
            return this;
          },
          async executeTakeFirst() {
            if (fail) throw new Error('connection reset');
            return { dashboard_write_policy: stored };
          },
        };
      },
    } as unknown as Kysely<Database>;
    const listener = new DashboardWritePolicyChangeListener({ pool, db, debounceMs: 5 });
    await listener.start();

    // Warm this peer's cache with the permissive map, then flip the shared
    // row — the setup a sibling coordinator's admin PATCH produces.
    expect(await getDashboardWritePolicy(db, 'customer-1')).toEqual({});
    stored = { 'secrets.set': DashboardWritePolicyState.enum.disabled };

    const eventSpy = vi.fn();
    dashboardWritePolicyEvents.on('changed', eventSpy);
    fail = true;
    client._emit(DASHBOARD_WRITE_POLICY_CHANNEL, 'customer-1');
    await vi.advanceTimersByTimeAsync(10);
    expect(eventSpy).not.toHaveBeenCalled();

    // A failed re-read degrades to a cache miss, never to a stale map: the
    // next read goes to the database and gets the new value. Without the
    // invalidation this returns the warmed `{}` for the rest of the TTL.
    fail = false;
    expect(await getDashboardWritePolicy(db, 'customer-1')).toEqual({
      'secrets.set': DashboardWritePolicyState.enum.disabled,
    });
    await listener.stop();
  });
});
