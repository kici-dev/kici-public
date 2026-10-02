/**
 * Tests for the internal-event inspection routes.
 *
 *   GET /api/v1/admin/events      — list, newest first, with filters
 *   GET /api/v1/admin/events/:id  — one event, its redacted payload and runs
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAdminEventInspectRoutes } from './admin-event-inspect.js';
import { RbacEnforcer, PermissionDeniedError, type Role } from '../secrets/rbac.js';
import { EventMatchOutcome, EventProcessingState, type StoredEvent } from '../events/types.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';

const EVENT_ID = '0b5c7a52-6c1e-4b8e-9d3a-7f1e2a3b4c5d';
const TOKEN = 'test-token-xyz';

function makeStoredEvent(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    id: EVENT_ID,
    eventName: 'kici.scaler.scale-up',
    payload: {
      scalerName: 'github-actions',
      agentId: 'scaler-event-1',
      claimCode: 'kcc_secret_value',
    },
    targetRepos: ['org/provision'],
    chainDepth: 0,
    processed: true,
    createdAt: new Date('2026-10-01T10:00:00Z'),
    expiresAt: new Date('2026-10-08T10:00:00Z'),
    claimedAt: null,
    claimedBy: null,
    attempts: 1,
    lastError: null,
    nextRetryAt: null,
    dlqAt: null,
    dlqReason: null,
    matchOutcome: EventMatchOutcome.enum['no-target-repo'],
    matchedCount: 0,
    ...overrides,
  };
}

function setup(
  opts: { routingKey?: string | null; runs?: unknown[]; rbac?: RbacEnforcer; role?: Role } = {},
) {
  const list = vi.fn().mockResolvedValue([makeStoredEvent()]);
  const getById = vi.fn().mockResolvedValue(makeStoredEvent());
  const { db, mocks } = createMockDb({ selectRows: opts.runs ?? [] });
  const tokenManager = {
    validate: vi.fn().mockResolvedValue({
      id: 'admin-user-1',
      role: opts.role ?? ('owner' as Role),
      routingKey: opts.routingKey ?? null,
      label: 'test',
    }),
  };
  const app = createAdminEventInspectRoutes({
    db,
    eventStore: { list, getById } as any,
    tokenManager: tokenManager as any,
    rbac: opts.rbac ?? new RbacEnforcer(),
  });
  const get = (path: string, token: string | null = TOKEN) =>
    app.request(`http://localhost${path}`, {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  return { app, get, list, getById, mocks };
}

describe('admin event inspection routes', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it('rejects a request without a Bearer token', async () => {
    expect((await ctx.get('/api/v1/admin/events', null)).status).toBe(401);
    expect((await ctx.get(`/api/v1/admin/events/${EVENT_ID}`, null)).status).toBe(401);
  });

  it('lists events with their state and match outcome', async () => {
    const res = await ctx.get('/api/v1/admin/events');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toEqual([
      expect.objectContaining({
        id: EVENT_ID,
        eventName: 'kici.scaler.scale-up',
        state: EventProcessingState.enum.processed,
        matchOutcome: EventMatchOutcome.enum['no-target-repo'],
        matchedCount: 0,
        targetRepos: ['org/provision'],
      }),
    ]);
    // A list row never carries the payload.
    expect(body.events[0].payload).toBeUndefined();
  });

  it('forwards the filters and clamps the limit', async () => {
    const res = await ctx.get(
      '/api/v1/admin/events?name=kici.scaler.scale-up&outcome=no-target-repo&since=2026-10-01T00:00:00Z&limit=500',
    );
    expect(res.status).toBe(200);
    expect(ctx.list).toHaveBeenCalledWith({
      name: 'kici.scaler.scale-up',
      outcome: EventMatchOutcome.enum['no-target-repo'],
      since: new Date('2026-10-01T00:00:00Z'),
      limit: 200,
    });
  });

  it('returns a next-page cursor when the page is full', async () => {
    const res = await ctx.get('/api/v1/admin/events?limit=1');
    expect((await res.json()).nextCursor).toBe(EVENT_ID);
  });

  it('reads an event-id cursor as the next page, and a timestamp as a time bound', async () => {
    await ctx.get(`/api/v1/admin/events?before=${EVENT_ID}`);
    expect(ctx.list).toHaveBeenLastCalledWith({ limit: 50, afterEventId: EVENT_ID });
    await ctx.get('/api/v1/admin/events?before=2026-10-01T00:00:00Z');
    expect(ctx.list).toHaveBeenLastCalledWith({
      limit: 50,
      before: new Date('2026-10-01T00:00:00Z'),
    });
  });

  it('refuses an unknown outcome or an unparseable time with 400', async () => {
    expect((await ctx.get('/api/v1/admin/events?outcome=nope')).status).toBe(400);
    expect((await ctx.get('/api/v1/admin/events?since=yesterday')).status).toBe(400);
    expect(ctx.list).not.toHaveBeenCalled();
  });

  it('refuses a role without event_dlq.read', async () => {
    const rbac = new RbacEnforcer();
    vi.spyOn(rbac, 'requirePermission').mockImplementation((role) => {
      throw new PermissionDeniedError(role, 'event_dlq.read');
    });
    ctx = setup({ rbac });
    expect((await ctx.get('/api/v1/admin/events')).status).toBe(403);
    expect((await ctx.get(`/api/v1/admin/events/${EVENT_ID}`)).status).toBe(403);
  });

  it('scopes a routing-key token to the events emitted under its key', async () => {
    ctx = setup({ routingKey: 'github:42' });
    await ctx.get('/api/v1/admin/events');
    expect(ctx.list).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRoutingKey: 'github:42' }),
    );
    // A scaler event has no source routing key, so a scoped token never reads it.
    expect((await ctx.get(`/api/v1/admin/events/${EVENT_ID}`)).status).toBe(403);
  });

  it('lets a scoped token read an event emitted under its own key', async () => {
    // breaks-if-wrong: the scope check must not refuse the token's own events
    ctx = setup({ routingKey: 'github:42' });
    ctx.getById.mockResolvedValue(makeStoredEvent({ sourceRoutingKey: 'github:42' }));
    expect((await ctx.get(`/api/v1/admin/events/${EVENT_ID}`)).status).toBe(200);
  });

  it('shows one event with the claim code redacted and the runs it dispatched', async () => {
    ctx = setup({
      runs: [
        {
          run_id: 'run-1',
          workflow_name: 'provision',
          status: 'success',
          created_at: new Date('2026-10-01T10:00:05Z'),
          delivery_id: EVENT_ID,
        },
        {
          run_id: 'run-other',
          workflow_name: 'unrelated',
          status: 'success',
          created_at: new Date('2026-10-01T10:00:06Z'),
          delivery_id: 'some-other-delivery',
        },
      ],
    });
    const res = await ctx.get(`/api/v1/admin/events/${EVENT_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    // fails-when: the single-use credential is echoed back
    expect(body.payload.claimCode).toBe('[redacted]');
    expect(body.payload.agentId).toBe('scaler-event-1');
    expect(JSON.stringify(body)).not.toContain('kcc_secret_value');
    expect(body.matchOutcome).toBe(EventMatchOutcome.enum['no-target-repo']);
    expect(body.runs).toEqual([
      {
        runId: 'run-1',
        workflowName: 'provision',
        status: 'success',
        createdAt: '2026-10-01T10:00:05.000Z',
      },
    ]);
    expect(ctx.mocks.selectWhere).toHaveBeenCalledWith('delivery_id', '=', EVENT_ID);
  });

  it('shows an auditor the event without its payload', async () => {
    // fails-when: event_dlq.read alone (the auditor role) reads payload bodies
    ctx = setup({ role: 'auditor' });
    const res = await ctx.get(`/api/v1/admin/events/${EVENT_ID}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text).payload).toBeNull();
    expect(text).not.toContain('scaler-event-1');
    // breaks-if-wrong: the auditor still reads the match outcome
    expect(JSON.parse(text).matchOutcome).toBe(EventMatchOutcome.enum['no-target-repo']);
  });

  it('leaves a payload without a claim code untouched', async () => {
    ctx.getById.mockResolvedValue(
      makeStoredEvent({ eventName: 'deploy-done', payload: { env: 'prod' } }),
    );
    const body = await (await ctx.get(`/api/v1/admin/events/${EVENT_ID}`)).json();
    expect(body.payload).toEqual({ env: 'prod' });
  });

  it('answers 400 for a non-UUID id and 404 for an unknown one', async () => {
    expect((await ctx.get('/api/v1/admin/events/not-a-uuid')).status).toBe(400);
    ctx.getById.mockResolvedValue(null);
    const res = await ctx.get(`/api/v1/admin/events/${EVENT_ID}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Event not found' });
  });
});
