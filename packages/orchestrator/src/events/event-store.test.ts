/**
 * Tests for EventStore -- internal event persistence with TTL cleanup,
 * lease-based dispatch, and DLQ handling.
 *
 * Uses a mock Kysely instance since JSONB columns are PostgreSQL-specific.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { EventStore, EVENT_CATCHUP_BATCH_SIZE, type NewEventInput } from './event-store.js';
import { DEFAULT_EVENT_ROUTER_CONFIG, EventMatchOutcome, type EventRouterConfig } from './types.js';

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
    match_outcome: null,
    matched_count: null,
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
    it('should return unprocessed events ordered by created_at ASC then id ASC', async () => {
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
      // Deterministic keyset ordering: created_at is the primary sort, id the tiebreaker.
      expect(mocks.selectOrderBy).toHaveBeenCalledWith('created_at', 'asc');
      expect(mocks.selectOrderBy).toHaveBeenCalledWith('id', 'asc');
    });

    it('should respect the limit parameter', async () => {
      const { db, mocks } = createMockDb({ selectManyResult: [] });
      const store = new EventStore(db, config);

      await store.getUnprocessedSince(null, 50);

      expect(mocks.selectLimit).toHaveBeenCalledWith(50);
    });

    it('should default limit to EVENT_CATCHUP_BATCH_SIZE (100)', async () => {
      const { db, mocks } = createMockDb({ selectManyResult: [] });
      const store = new EventStore(db, config);

      await store.getUnprocessedSince(null);

      expect(mocks.selectLimit).toHaveBeenCalledWith(EVENT_CATCHUP_BATCH_SIZE);
      expect(EVENT_CATCHUP_BATCH_SIZE).toBe(100);
    });

    it('should look up the reference event to build a composite (created_at, id) cursor when sinceId is given', async () => {
      // selectOneResult feeds the executeTakeFirst() ref-lookup for created_at;
      // selectManyResult feeds the final .execute() page.
      const { db, mocks } = createMockDb({
        selectOneResult: { created_at: new Date('2026-02-22T10:00:00Z') },
        selectManyResult: [
          makeDbRow({ id: 'evt-3', created_at: new Date('2026-02-22T10:02:00Z') }),
        ],
      });
      const store = new EventStore(db, config);

      const events = await store.getUnprocessedSince('evt-boundary');

      // The ref event's created_at was fetched to anchor the keyset cursor.
      expect(mocks.selectWhere).toHaveBeenCalledWith('id', '=', 'evt-boundary');
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe('evt-3');
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

    it('records the match outcome when one is given', async () => {
      // fails-when: markProcessed drops the router's result
      const { db, mocks } = createMockDb();
      const store = new EventStore(db, config);

      await store.markProcessed('evt-001', {
        outcome: EventMatchOutcome.enum['no-target-repo'],
        matchedCount: 0,
      });

      expect(mocks.updateSet).toHaveBeenCalledWith({
        processed: true,
        claimed_at: null,
        claimed_by: null,
        match_outcome: 'no-target-repo',
        matched_count: 0,
      });
    });
  });

  describe('list', () => {
    it('applies every filter and orders newest first', async () => {
      const rows = [
        makeDbRow({
          id: 'evt-new',
          event_name: 'kici.scaler.scale-up',
          match_outcome: 'no-target-repo',
          created_at: new Date('2026-10-01T12:00:00Z'),
        }),
        makeDbRow({
          id: 'evt-other',
          event_name: 'deploy-complete',
          match_outcome: 'matched',
          created_at: new Date('2026-10-01T12:00:00Z'),
        }),
      ];
      const { db, mocks } = createMockDb({ selectManyResult: rows });
      const store = new EventStore(db, config);

      const events = await store.list({
        name: 'kici.scaler.scale-up',
        outcome: EventMatchOutcome.enum['no-target-repo'],
        since: new Date('2026-10-01T00:00:00Z'),
        before: new Date('2026-10-02T00:00:00Z'),
        limit: 25,
        sourceRoutingKey: 'github:42',
      });

      // The mock applies the where predicates, so the other event is filtered out.
      expect(events.map((e) => e.id)).toEqual(['evt-new']);
      expect(mocks.selectWhere).toHaveBeenCalledWith('event_name', '=', 'kici.scaler.scale-up');
      expect(mocks.selectWhere).toHaveBeenCalledWith('match_outcome', '=', 'no-target-repo');
      expect(mocks.selectWhere).toHaveBeenCalledWith(
        'created_at',
        '>=',
        new Date('2026-10-01T00:00:00Z'),
      );
      expect(mocks.selectWhere).toHaveBeenCalledWith(
        'created_at',
        '<',
        new Date('2026-10-02T00:00:00Z'),
      );
      expect(mocks.selectWhere).toHaveBeenCalledWith('source_routing_key', '=', 'github:42');
      expect(mocks.selectOrderBy).toHaveBeenCalledWith('created_at', 'desc');
      expect(mocks.selectLimit).toHaveBeenCalledWith(25);
    });

    it('adds no filter the caller did not ask for', async () => {
      const { db, mocks } = createMockDb({ selectManyResult: [makeDbRow()] });
      const events = await new EventStore(db, config).list({ limit: 10 });
      expect(events).toHaveLength(1);
      expect(mocks.selectWhere).not.toHaveBeenCalled();
    });
  });

  describe('match outcome mapping', () => {
    it('reads a stored outcome and count', async () => {
      const { db } = createMockDb({
        selectOneResult: makeDbRow({ match_outcome: 'matched', matched_count: 2 }),
      });
      const event = await new EventStore(db, config).getById('evt-001');
      expect(event!.matchOutcome).toBe(EventMatchOutcome.enum.matched);
      expect(event!.matchedCount).toBe(2);
    });

    it('reads an outcome this build does not know as null', async () => {
      // breaks-if-wrong: a row a newer peer wrote must not fail the read
      const { db } = createMockDb({
        selectOneResult: makeDbRow({ match_outcome: 'some-future-outcome', matched_count: 0 }),
      });
      const event = await new EventStore(db, config).getById('evt-001');
      expect(event!.matchOutcome).toBeNull();
      expect(event!.matchedCount).toBe(0);
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
