/**
 * Tests for EventStore -- internal event persistence with TTL cleanup,
 * lease-based dispatch, and DLQ handling.
 *
 * Uses a mock Kysely instance since JSONB columns are PostgreSQL-specific.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { EventStore, type NewEventInput } from './event-store.js';
import { DEFAULT_EVENT_ROUTER_CONFIG, type EventRouterConfig } from './types.js';

// ── Mock helpers ────────────────────────────────────────────────

function makeStoredEventInput(): NewEventInput {
  return {
    eventName: 'deploy-complete',
    payload: { env: 'production', version: '1.2.3' },
    sourceRepo: 'owner/repo',
    sourceRoutingKey: 'github:42',
    sourceRunId: 'run-123',
    sourceJobId: 'job-456',
    chainDepth: 0,
    expiresAt: new Date('2026-03-01T00:00:00Z'),
  };
}

function makeDbRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'evt-001',
    event_name: 'deploy-complete',
    payload: JSON.stringify({ env: 'production', version: '1.2.3' }),
    source_repo: 'owner/repo',
    source_routing_key: 'github:42',
    source_run_id: 'run-123',
    source_job_id: 'job-456',
    chain_depth: 0,
    processed: false,
    created_at: new Date('2026-02-22T10:00:00Z'),
    expires_at: new Date('2026-03-01T00:00:00Z'),
    claimed_at: null,
    claimed_by: null,
    attempts: 0,
    last_error: null,
    next_retry_at: null,
    dlq_at: null,
    dlq_reason: null,
    ...overrides,
  };
}

/**
 * Create a mock Kysely db for EventStore using the shared helper.
 */
import { createMockDb as _createMockDb } from '../__test-helpers__/mock-db.js';

function createMockDb(
  options: {
    insertResult?: { id: string };
    selectOneResult?: Record<string, unknown> | null;
    selectManyResult?: Record<string, unknown>[];
    deleteCount?: number;
    updatedRow?: Record<string, unknown>;
  } = {},
) {
  const insertResult = options.insertResult ?? { id: 'evt-001' };
  const selectOneResult = 'selectOneResult' in options ? options.selectOneResult : makeDbRow();
  const selectManyResult = options.selectManyResult ?? [];

  return _createMockDb({
    insertReturning: insertResult,
    selectFirstRow: selectOneResult ?? undefined,
    selectRows: selectManyResult,
    updateResult: { numUpdatedRows: 1n },
    updatedRow: options.updatedRow,
  });
}

// ── Tests ────────────────────────────────────────────────────────

describe('EventStore', () => {
  let config: EventRouterConfig;

  beforeEach(() => {
    config = { ...DEFAULT_EVENT_ROUTER_CONFIG };
  });

  describe('write', () => {
    it('should insert an event and return the generated ID', async () => {
      const { db, mocks } = createMockDb({ insertResult: { id: 'evt-new' } });
      const store = new EventStore(db, config);
      const input = makeStoredEventInput();

      const id = await store.write(input);

      expect(id).toBe('evt-new');
      expect(mocks.insertInto).toHaveBeenCalledWith('kici_events');
      expect(mocks.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          event_name: 'deploy-complete',
          payload: JSON.stringify({ env: 'production', version: '1.2.3' }),
          source_repo: 'owner/repo',
          source_routing_key: 'github:42',
          source_run_id: 'run-123',
          source_job_id: 'job-456',
          chain_depth: 0,
        }),
      );
      expect(mocks.insertReturning).toHaveBeenCalledWith('id');
    });

    it('should set null for optional fields when not provided', async () => {
      const { db, mocks } = createMockDb();
      const store = new EventStore(db, config);

      await store.write({
        eventName: 'test-event',
        payload: {},
        chainDepth: 0,
        expiresAt: new Date(),
      });

      expect(mocks.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          source_repo: null,
          source_routing_key: null,
          source_run_id: null,
          source_job_id: null,
        }),
      );
    });
  });

  describe('getById', () => {
    it('should return a StoredEvent when found', async () => {
      const row = makeDbRow();
      const { db } = createMockDb({ selectOneResult: row });
      const store = new EventStore(db, config);

      const event = await store.getById('evt-001');

      expect(event).not.toBeNull();
      expect(event!.id).toBe('evt-001');
      expect(event!.eventName).toBe('deploy-complete');
      expect(event!.payload).toEqual({ env: 'production', version: '1.2.3' });
      expect(event!.sourceRepo).toBe('owner/repo');
      expect(event!.chainDepth).toBe(0);
      expect(event!.processed).toBe(false);
    });

    it('should return null when not found', async () => {
      const { db } = createMockDb({ selectOneResult: null });
      const store = new EventStore(db, config);

      const event = await store.getById('nonexistent');

      expect(event).toBeNull();
    });

    it('should map null DB fields to undefined on StoredEvent', async () => {
      const row = makeDbRow({
        source_repo: null,
        source_routing_key: null,
        source_run_id: null,
        source_job_id: null,
      });
      const { db } = createMockDb({ selectOneResult: row });
      const store = new EventStore(db, config);

      const event = await store.getById('evt-001');

      expect(event!.sourceRepo).toBeUndefined();
      expect(event!.sourceRoutingKey).toBeUndefined();
      expect(event!.sourceRunId).toBeUndefined();
      expect(event!.sourceJobId).toBeUndefined();
    });
  });

  describe('getUnprocessedSince', () => {
    it('should return unprocessed events ordered by created_at ASC', async () => {
      const rows = [
        makeDbRow({ id: 'evt-1', created_at: new Date('2026-02-22T10:00:00Z') }),
        makeDbRow({ id: 'evt-2', created_at: new Date('2026-02-22T10:01:00Z') }),
      ];
      const { db, mocks } = createMockDb({ selectManyResult: rows });
      const store = new EventStore(db, config);

      const events = await store.getUnprocessedSince(null);

      expect(events).toHaveLength(2);
      expect(events[0].id).toBe('evt-1');
      expect(events[1].id).toBe('evt-2');
      expect(mocks.selectWhere).toHaveBeenCalledWith('processed', '=', false);
    });

    it('should respect the limit parameter', async () => {
      const { db, mocks } = createMockDb({ selectManyResult: [] });
      const store = new EventStore(db, config);

      await store.getUnprocessedSince(null, 50);

      expect(mocks.selectLimit).toHaveBeenCalledWith(50);
    });

    it('should default limit to 100', async () => {
      const { db, mocks } = createMockDb({ selectManyResult: [] });
      const store = new EventStore(db, config);

      await store.getUnprocessedSince(null);

      expect(mocks.selectLimit).toHaveBeenCalledWith(100);
    });
  });

  describe('markProcessed', () => {
    it('should set processed=true and clear the lease', async () => {
      const { db, mocks } = createMockDb();
      const store = new EventStore(db, config);

      await store.markProcessed('evt-001');

      expect(mocks.updateTable).toHaveBeenCalledWith('kici_events');
      // Lease columns are cleared together with the processed flag so the row
      // is unambiguously terminal (no stale claimed_by hanging around).
      expect(mocks.updateSet).toHaveBeenCalledWith({
        processed: true,
        claimed_at: null,
        claimed_by: null,
      });
      expect(mocks.updateWhere).toHaveBeenCalledWith('id', '=', 'evt-001');
    });
  });

  describe('tryLeaseForProcessing', () => {
    it('should return a StoredEvent when the lease is acquired', async () => {
      const row = makeDbRow({ processed: false, attempts: 1, claimed_by: 'node-A' });
      const { db, mocks } = createMockDb({ updatedRow: row });
      const store = new EventStore(db, config);

      const event = await store.tryLeaseForProcessing('evt-001', 'node-A');

      expect(event).not.toBeNull();
      expect(event!.id).toBe('evt-001');
      expect(event!.attempts).toBe(1);
      expect(event!.claimedBy).toBe('node-A');
      expect(mocks.updateTable).toHaveBeenCalledWith('kici_events');
    });

    it('should return null when the event is already processed / DLQ / leased', async () => {
      const { db } = createMockDb({ updatedRow: undefined });
      const store = new EventStore(db, config);

      const event = await store.tryLeaseForProcessing('evt-busy', 'node-A');

      expect(event).toBeNull();
    });
  });

  describe('cleanup timer', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should start and stop cleanup timer', () => {
      const { db } = createMockDb();
      const store = new EventStore(db, { ...config, cleanupIntervalMs: 100 });

      store.startCleanupTimer();
      // Starting again should be a no-op
      store.startCleanupTimer();

      store.stopCleanupTimer();
      // Stopping again should be a no-op
      store.stopCleanupTimer();
    });
  });
});
