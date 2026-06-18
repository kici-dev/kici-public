/**
 * Unit tests for EventLogWriter.
 *
 * Exercises every status path (received/processed/duplicate/lockfile_missing/
 * failed), the size-cap omit path, the storage-failure omit path, and the
 * cross-tier hash equality assertion (the orchestrator MUST hash with the
 * same `sha256()` function Platform uses so the merge join works).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sha256 } from '@kici-dev/shared';
import { EventLogStatus, PayloadOmittedReason, EventLogSource } from '@kici-dev/engine';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { LogStorage } from '../reporting/log-storage.js';
import type { WebhookInfo } from './handler.js';
import { EventLogWriter, payloadFromObject, payloadFromRawBody } from './event-log.js';

// ── Mock builders ─────────────────────────────────────────────

interface InsertedRow {
  values: Record<string, unknown>;
  conflictUpdate: Record<string, unknown> | null;
}

function createMockDb() {
  const inserts: InsertedRow[] = [];

  const onConflictBuilder = (updates: Record<string, unknown> | null) => ({
    columns: () => ({
      doUpdateSet: (set: Record<string, unknown>) => {
        // mutate the captured update set
        if (updates) {
          Object.assign(updates, set);
        }
        return {};
      },
    }),
  });

  const insertBuilder = {
    values: (values: Record<string, unknown>) => {
      const conflictUpdate: Record<string, unknown> = {};
      const captured: InsertedRow = { values, conflictUpdate };
      inserts.push(captured);
      return {
        onConflict: (cb: (oc: ReturnType<typeof onConflictBuilder>) => unknown) => {
          cb(onConflictBuilder(conflictUpdate));
          return {
            execute: vi.fn().mockResolvedValue(undefined),
          };
        },
      };
    },
  };

  const mockDb = {
    insertInto: vi.fn().mockImplementation(() => insertBuilder),
    selectFrom: vi.fn().mockImplementation(() => ({
      select: () => ({
        where: () => ({
          limit: () => ({
            execute: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    })),
    deleteFrom: vi.fn().mockImplementation(() => ({
      where: () => ({
        executeTakeFirst: vi.fn().mockResolvedValue({ numDeletedRows: 0n }),
      }),
    })),
    _inserts: inserts,
  } as unknown as Kysely<Database> & { _inserts: InsertedRow[] };

  return mockDb;
}

function createMockLogStorage(opts?: { failOnAppend?: boolean }) {
  const writes: Array<{ path: string; data: string }> = [];
  return {
    append: vi.fn().mockImplementation(async (path: string, data: string) => {
      if (opts?.failOnAppend) {
        throw new Error('S3 disconnected');
      }
      writes.push({ path, data });
    }),
    read: vi.fn(),
    exists: vi.fn(),
    list: vi.fn(),
    _writes: writes,
  } as unknown as LogStorage & { _writes: typeof writes };
}

const baseInfo: WebhookInfo = {
  routingKey: 'github:42',
  deliveryId: 'delivery-abc-123',
  event: 'push',
  action: null,
  provider: 'github',
  payload: { ref: 'refs/heads/main', commit: 'deadbeef' } as Record<string, unknown>,
};

function newWriter(opts?: {
  db?: ReturnType<typeof createMockDb>;
  storage?: ReturnType<typeof createMockLogStorage>;
  maxPayloadBytes?: number;
}) {
  const db = opts?.db ?? createMockDb();
  const storage = opts?.storage ?? createMockLogStorage();
  const writer = new EventLogWriter(db, storage, {
    maxPayloadBytes: opts?.maxPayloadBytes ?? 5 * 1024 * 1024,
  });
  return { writer, db, storage };
}

// ── Tests ─────────────────────────────────────────────────────

describe('EventLogWriter', () => {
  describe('hashing', () => {
    it('uses the same sha256() as @kici-dev/shared (cross-tier join key)', async () => {
      const { writer, db } = newWriter();
      const payload = payloadFromObject(baseInfo.payload);
      const expected = sha256(payload.raw);

      await writer.record(baseInfo, payload, {
        orgId: 'org-001',
        source: EventLogSource.enum.relay,
        status: EventLogStatus.enum.processed,
      });

      expect(db._inserts).toHaveLength(1);
      expect(db._inserts[0].values.payload_hash).toBe(expected);
    });

    it('hashes raw bytes byte-for-byte (matches Platform direct path)', async () => {
      const { writer, db } = newWriter();
      const rawBody = '{"hello":"world"}';
      const payload = payloadFromRawBody(rawBody);

      await writer.record(baseInfo, payload, {
        orgId: 'org-001',
        source: EventLogSource.enum.direct,
        status: EventLogStatus.enum.processed,
      });

      expect(db._inserts[0].values.payload_hash).toBe(sha256(rawBody));
    });
  });

  describe('happy-path object-storage upload', () => {
    let result: ReturnType<typeof newWriter>;

    beforeEach(async () => {
      result = newWriter();
      await result.writer.record(baseInfo, payloadFromObject(baseInfo.payload), {
        orgId: 'org-001',
        source: EventLogSource.enum.relay,
        status: EventLogStatus.enum.processed,
        matchedCount: 2,
        repoIdentifier: 'example-org/example-repo',
        ref: 'refs/heads/main',
        runId: '00000000-0000-0000-0000-000000000abc',
      });
    });

    it('uploads payload to event-log/<orgId>/<deliveryId>.json.gz', () => {
      expect(result.storage._writes).toHaveLength(1);
      expect(result.storage._writes[0].path).toBe('event-log/org-001/delivery-abc-123.json.gz');
    });

    it('writes the row with payload_omitted=false and a payload_key', () => {
      const row = result.db._inserts[0].values;
      expect(row.payload_omitted).toBe(false);
      expect(row.payload_omitted_reason).toBeNull();
      expect(row.payload_key).toBe('event-log/org-001/delivery-abc-123.json.gz');
    });

    it('records the outcome metadata', () => {
      const row = result.db._inserts[0].values;
      expect(row.org_id).toBe('org-001');
      expect(row.delivery_id).toBe('delivery-abc-123');
      expect(row.routing_key).toBe('github:42');
      expect(row.event).toBe('push');
      expect(row.source).toBe(EventLogSource.enum.relay);
      expect(row.provider).toBe('github');
      expect(row.repo_identifier).toBe('example-org/example-repo');
      expect(row.ref).toBe('refs/heads/main');
      expect(row.matched_count).toBe(2);
      expect(row.status).toBe(EventLogStatus.enum.processed);
      expect(row.run_id).toBe('00000000-0000-0000-0000-000000000abc');
      expect(row.payload_size_bytes).toBe(
        Buffer.byteLength(JSON.stringify(baseInfo.payload), 'utf-8'),
      );
    });
  });

  describe('size-cap omit path', () => {
    it('records payload_omitted=true with reason size_exceeded and skips upload', async () => {
      // Cap at 32 bytes; the JSON serialization of baseInfo.payload is larger.
      const { writer, db, storage } = newWriter({ maxPayloadBytes: 32 });

      await writer.record(baseInfo, payloadFromObject(baseInfo.payload), {
        orgId: 'org-001',
        source: EventLogSource.enum.direct,
        status: EventLogStatus.enum.processed,
      });

      expect(storage._writes).toHaveLength(0);
      const row = db._inserts[0].values;
      expect(row.payload_omitted).toBe(true);
      expect(row.payload_omitted_reason).toBe(PayloadOmittedReason.enum.size_exceeded);
      expect(row.payload_key).toBeNull();
      // Hash + size are still recorded for correlation.
      expect(row.payload_hash).toBeTruthy();
      expect(row.payload_size_bytes).toBeGreaterThan(32);
    });
  });

  describe('storage-failure omit path', () => {
    it('records payload_omitted=true with reason storage_failed and continues', async () => {
      const { writer, db } = newWriter({ storage: createMockLogStorage({ failOnAppend: true }) });

      await writer.record(baseInfo, payloadFromObject(baseInfo.payload), {
        orgId: 'org-001',
        source: EventLogSource.enum.relay,
        status: EventLogStatus.enum.processed,
      });

      const row = db._inserts[0].values;
      expect(row.payload_omitted).toBe(true);
      expect(row.payload_omitted_reason).toBe(PayloadOmittedReason.enum.storage_failed);
      expect(row.payload_key).toBeNull();
      // Even on storage failure, the row is still written.
      expect(row.status).toBe(EventLogStatus.enum.processed);
    });
  });

  describe('all status branches', () => {
    it.each([
      EventLogStatus.enum.received,
      EventLogStatus.enum.processed,
      EventLogStatus.enum.duplicate,
      EventLogStatus.enum.lockfile_missing,
      EventLogStatus.enum.failed,
    ])('records status=%s', async (status) => {
      const { writer, db } = newWriter();
      await writer.record(baseInfo, payloadFromObject(baseInfo.payload), {
        orgId: 'org-001',
        source: EventLogSource.enum.direct,
        status,
        ...(status === EventLogStatus.enum.failed && { errorMessage: 'kaboom' }),
      });
      const row = db._inserts[0].values;
      expect(row.status).toBe(status);
      if (status === EventLogStatus.enum.failed) {
        expect(row.error_message).toBe('kaboom');
      }
    });
  });

  describe('idempotent upsert on (org_id, delivery_id)', () => {
    it('updates outcome fields on conflict but not body-derived fields', async () => {
      const { writer, db } = newWriter();
      await writer.record(baseInfo, payloadFromObject(baseInfo.payload), {
        orgId: 'org-001',
        source: EventLogSource.enum.direct,
        status: EventLogStatus.enum.received,
      });
      // The conflictUpdate captures what fields would be set on conflict.
      const update = db._inserts[0].conflictUpdate;
      // Outcome fields: present
      expect(update).toHaveProperty('status');
      expect(update).toHaveProperty('run_id');
      expect(update).toHaveProperty('matched_count');
      expect(update).toHaveProperty('error_message');
      expect(update).toHaveProperty('repo_identifier');
      expect(update).toHaveProperty('ref');
      // Body-derived fields: NOT present
      expect(update).not.toHaveProperty('payload_key');
      // expires_at: removed by Phase E (cold-store replaces hard-delete TTL)
      expect(update).not.toHaveProperty('expires_at');
      expect(update).not.toHaveProperty('payload_hash');
      expect(update).not.toHaveProperty('payload_size_bytes');
      expect(update).not.toHaveProperty('payload_omitted');
      expect(update).not.toHaveProperty('payload_omitted_reason');
      expect(update).not.toHaveProperty('routing_key');
      expect(update).not.toHaveProperty('source');
      expect(update).not.toHaveProperty('provider');
    });
  });

  describe('payloadKey()', () => {
    it('encodes path-unsafe characters in delivery IDs', () => {
      const key = EventLogWriter.payloadKey('org-001', 'generic:my-org:src/with slash');
      // The slash and space must NOT appear unencoded in the key segment.
      expect(key.startsWith('event-log/org-001/')).toBe(true);
      const segment = key.substring('event-log/org-001/'.length);
      expect(segment).not.toContain('/');
      expect(segment).not.toContain(' ');
    });

    it('passes through safe characters as-is', () => {
      const key = EventLogWriter.payloadKey('org-001', 'abc-DEF_123.456:789');
      expect(key).toBe('event-log/org-001/abc-DEF_123.456:789.json.gz');
    });
  });
});
