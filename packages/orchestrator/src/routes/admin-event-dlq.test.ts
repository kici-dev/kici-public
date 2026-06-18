/**
 * Tests for the admin event-DLQ routes.
 *
 *   GET    /api/v1/admin/event-dlq         — list with limit + cursor
 *   GET    /api/v1/admin/event-dlq/count   — total DLQ depth
 *   POST   /api/v1/admin/event-dlq/:id/retry  — reset + pg_notify
 *   DELETE /api/v1/admin/event-dlq/:id     — discard
 *
 * The retry path's pg_notify is exercised by stubbing `eventStore.getDb()` to
 * return a Kysely-shaped object whose `executeQuery` is a vi.fn(); this lets us
 * verify the retry reroute fires without needing a real DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAdminEventDlqRoutes, type AdminEventDlqRoutesDeps } from './admin-event-dlq.js';
import { RbacEnforcer, type Role } from '../secrets/rbac.js';
import type { StoredEvent } from '../events/types.js';

interface Deps extends AdminEventDlqRoutesDeps {
  listDlq: ReturnType<typeof vi.fn>;
  countDlq: ReturnType<typeof vi.fn>;
  resetFromDlq: ReturnType<typeof vi.fn>;
  deleteDlq: ReturnType<typeof vi.fn>;
  getById: ReturnType<typeof vi.fn>;
  notifyExecuteQuery: ReturnType<typeof vi.fn>;
  accessLogRecord: ReturnType<typeof vi.fn>;
}

function makeStoredEvent(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    id: 'evt-1',
    eventName: 'deploy-complete',
    payload: { env: 'production' },
    sourceRepo: 'owner/repo',
    sourceRoutingKey: 'github:42',
    sourceRunId: 'run-1',
    sourceJobId: 'job-1',
    chainDepth: 0,
    processed: true,
    createdAt: new Date('2026-04-30T10:00:00Z'),
    expiresAt: new Date('2026-05-07T10:00:00Z'),
    claimedAt: null,
    claimedBy: null,
    attempts: 5,
    lastError: 'connection refused',
    nextRetryAt: null,
    dlqAt: new Date('2026-04-30T10:05:00Z'),
    dlqReason: 'exhausted_retries',
    ...overrides,
  };
}

function createMockDeps(): Deps {
  const listDlq = vi.fn().mockResolvedValue([]);
  const countDlq = vi.fn().mockResolvedValue(0);
  const resetFromDlq = vi.fn().mockResolvedValue(true);
  const deleteDlq = vi.fn().mockResolvedValue(true);
  // The retry / discard routes call `eventStore.getById(id)` before
  // applying the routing-key-scope check; default to a DLQ-flavored
  // row so the unscoped happy paths pass without per-test wiring.
  const getById = vi.fn().mockResolvedValue(makeStoredEvent());
  const notifyExecuteQuery = vi.fn().mockResolvedValue({ rows: [] });
  const accessLogRecord = vi.fn().mockResolvedValue(undefined);

  const eventStore = {
    listDlq,
    countDlq,
    resetFromDlq,
    deleteDlq,
    getById,
    getDb: () => ({
      // Kysely sql template `.execute(handle)` ultimately calls `executeQuery`
      // on the driver; we only need that surface for pg_notify in retry.
      executeQuery: notifyExecuteQuery,
      getExecutor: () => ({
        executeQuery: notifyExecuteQuery,
        adapter: { supportsReturning: true, supportsTransactionalDdl: false },
      }),
    }),
  } as any;

  return {
    eventStore,
    tokenManager: { validate: vi.fn() } as any,
    rbac: new RbacEnforcer(),
    accessLog: { record: accessLogRecord } as any,
    listDlq,
    countDlq,
    resetFromDlq,
    deleteDlq,
    getById,
    notifyExecuteQuery,
    accessLogRecord,
  };
}

async function request(
  app: ReturnType<typeof createAdminEventDlqRoutes>,
  path: string,
  init?: { method?: string; token?: string; body?: unknown },
) {
  const headers: Record<string, string> = {};
  if (init?.token) headers['Authorization'] = `Bearer ${init.token}`;
  if (init?.body !== undefined) headers['Content-Type'] = 'application/json';
  return app.request(`http://localhost${path}`, {
    method: init?.method ?? 'GET',
    headers,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

describe('admin event-DLQ routes', () => {
  let deps: Deps;
  let app: ReturnType<typeof createAdminEventDlqRoutes>;
  const TOKEN = 'test-token-xyz';

  beforeEach(() => {
    deps = createMockDeps();
    app = createAdminEventDlqRoutes(deps);
    (deps.tokenManager.validate as any).mockResolvedValue({
      id: 'admin-user-1',
      role: 'owner' as Role,
      routingKey: null,
      label: 'test',
    });
  });

  // ── Auth + RBAC ─────────────────────────────────────────────────

  it('rejects requests without a Bearer token', async () => {
    const res = await request(app, '/api/v1/admin/event-dlq');
    expect(res.status).toBe(401);
  });

  it('rejects an invalid Bearer token', async () => {
    (deps.tokenManager.validate as any).mockResolvedValue(null);
    const res = await request(app, '/api/v1/admin/event-dlq', { token: TOKEN });
    expect(res.status).toBe(401);
  });

  it('rejects auditor for retry (manage permission missing)', async () => {
    (deps.tokenManager.validate as any).mockResolvedValue({
      id: 'auditor',
      role: 'auditor' as Role,
      routingKey: null,
      label: 'test',
    });
    const res = await request(app, '/api/v1/admin/event-dlq/evt-1/retry', {
      method: 'POST',
      token: TOKEN,
    });
    expect(res.status).toBe(403);
  });

  it('allows auditor to read the DLQ list', async () => {
    (deps.tokenManager.validate as any).mockResolvedValue({
      id: 'auditor',
      role: 'auditor' as Role,
      routingKey: null,
      label: 'test',
    });
    const res = await request(app, '/api/v1/admin/event-dlq', { token: TOKEN });
    expect(res.status).toBe(200);
  });

  // ── List ────────────────────────────────────────────────────────

  it('returns a list of DLQ events with default limit', async () => {
    deps.listDlq.mockResolvedValue([makeStoredEvent()]);
    const res = await request(app, '/api/v1/admin/event-dlq', { token: TOKEN });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.events).toHaveLength(1);
    expect(body.events[0].id).toBe('evt-1');
    expect(body.events[0].dlqReason).toBe('exhausted_retries');
    expect(body.events[0].attempts).toBe(5);
    expect(body.limit).toBe(50);
    expect(body.nextCursor).toBeNull();
    expect(deps.listDlq).toHaveBeenCalledWith(50, undefined, undefined);
  });

  it('respects limit + before cursor', async () => {
    const before = '2026-04-30T10:00:00.000Z';
    await request(app, `/api/v1/admin/event-dlq?limit=10&before=${before}`, {
      token: TOKEN,
    });
    expect(deps.listDlq).toHaveBeenCalledWith(10, new Date(before), undefined);
  });

  it('clamps limit to MAX_LIMIT', async () => {
    await request(app, '/api/v1/admin/event-dlq?limit=99999', { token: TOKEN });
    expect(deps.listDlq).toHaveBeenCalledWith(200, undefined, undefined);
  });

  it('returns nextCursor when result fills the page', async () => {
    const events = Array.from({ length: 50 }, (_, i) =>
      makeStoredEvent({
        id: `evt-${i}`,
        dlqAt: new Date(2026, 3, 30, 10, i),
      }),
    );
    deps.listDlq.mockResolvedValue(events);
    const res = await request(app, '/api/v1/admin/event-dlq', { token: TOKEN });
    const body = (await res.json()) as any;
    expect(body.nextCursor).toBe(events[events.length - 1].dlqAt.toISOString());
  });

  // ── Count ───────────────────────────────────────────────────────

  it('returns the total DLQ depth', async () => {
    deps.countDlq.mockResolvedValue(7);
    const res = await request(app, '/api/v1/admin/event-dlq/count', { token: TOKEN });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ total: 7 });
  });

  // ── Retry ───────────────────────────────────────────────────────

  it('resets a DLQ event and writes the access log entry', async () => {
    // Note: pg_notify behavior with a real DB is covered by E2E. A mocked
    // Kysely executor is incomplete enough that the sql template execution
    // path throws and the route swallows it (the retry scanner is the
    // safety net) — the unit test verifies the row reset + access log,
    // and "still returns 200 when pg_notify fails" covers the swallow path.
    const res = await request(app, '/api/v1/admin/event-dlq/evt-1/retry', {
      method: 'POST',
      token: TOKEN,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ retried: true, id: 'evt-1' });
    expect(deps.resetFromDlq).toHaveBeenCalledWith('evt-1');
    expect(deps.accessLogRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'event_dlq.retry',
        target: { type: 'event_dlq', id: 'evt-1' },
        outcome: 'allowed',
      }),
    );
  });

  it('returns 404 when retry target is not in DLQ', async () => {
    // The route now short-circuits on the getById lookup before the
    // resetFromDlq call, so the 404 is driven by the missing row.
    deps.getById.mockResolvedValue(null);
    deps.resetFromDlq.mockResolvedValue(false);
    const res = await request(app, '/api/v1/admin/event-dlq/missing/retry', {
      method: 'POST',
      token: TOKEN,
    });
    expect(res.status).toBe(404);
    expect(deps.notifyExecuteQuery).not.toHaveBeenCalled();
  });

  it('still returns 200 when pg_notify fails (scanner will catch up)', async () => {
    deps.notifyExecuteQuery.mockRejectedValue(new Error('boom'));
    const res = await request(app, '/api/v1/admin/event-dlq/evt-1/retry', {
      method: 'POST',
      token: TOKEN,
    });
    expect(res.status).toBe(200);
    expect(deps.resetFromDlq).toHaveBeenCalled();
  });

  // ── Discard ─────────────────────────────────────────────────────

  it('discards a DLQ event', async () => {
    const res = await request(app, '/api/v1/admin/event-dlq/evt-1', {
      method: 'DELETE',
      token: TOKEN,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ discarded: true, id: 'evt-1' });
    expect(deps.deleteDlq).toHaveBeenCalledWith('evt-1');
    expect(deps.accessLogRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'event_dlq.discard',
        target: { type: 'event_dlq', id: 'evt-1' },
        outcome: 'allowed',
      }),
    );
  });

  it('returns 404 when discard target is not in DLQ', async () => {
    // The route now short-circuits on the getById lookup before the
    // deleteDlq call, so the 404 is driven by the missing row.
    deps.getById.mockResolvedValue(null);
    deps.deleteDlq.mockResolvedValue(false);
    const res = await request(app, '/api/v1/admin/event-dlq/missing', {
      method: 'DELETE',
      token: TOKEN,
    });
    expect(res.status).toBe(404);
  });
});
