/**
 * Tests for AgentTokenStore.
 *
 * Uses mock Kysely DB to verify:
 * - createStatic returns token with kat_ prefix, 68 chars total, unique id
 * - createEphemeral returns token with kat_ prefix, stores expires_at
 * - validate returns row for valid token, null for invalid/revoked/expired
 * - revoke returns true on first call, false on second
 * - list returns tokens, filters by type
 * - cleanupExpired removes expired ephemeral tokens
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { AgentTokenStore } from './token-store.js';

// ── Mock Kysely builder ─────────────────────────────────────────

import { createMockDb as _createMockDb } from '../__test-helpers__/mock-db.js';

interface MockDbConfig {
  selectFirstRow?: Record<string, unknown> | undefined;
  selectRows?: Record<string, unknown>[];
  insertedRow?: Record<string, unknown>;
  updateResult?: { numUpdatedRows: bigint };
  deleteResult?: { numDeletedRows: bigint };
}

/**
 * Create a mock Kysely DB for AgentTokenStore tests.
 * Returns { db, terminal, ... } for backward compatibility with existing assertions.
 */
function createMockDb(opts: MockDbConfig = {}) {
  const defaultInsertedRow = opts.insertedRow ?? {
    id: 'tok-001',
    token_hash: 'hash',
    token_prefix: 'kat_00000000',
    labels: null,
    agent_type: 'static',
    created_at: new Date(),
    last_seen_at: null,
    created_by: null,
    revoked_at: null,
    expires_at: null,
  };

  const { db, mocks } = _createMockDb({
    selectFirstRow: opts.selectFirstRow,
    selectRows: opts.selectRows ?? [],
    insertedRow: defaultInsertedRow,
    updateResult: opts.updateResult ?? { numUpdatedRows: 1n },
    deleteResult: opts.deleteResult ?? { numDeletedRows: 0n },
  });

  // Expose terminal-like object for backward-compatible test assertions
  const terminal = {
    execute: mocks.selectExecute,
    executeTakeFirst: mocks.selectExecuteTakeFirst,
    where: mocks.selectWhere,
    orderBy: mocks.selectOrderBy,
  };

  return {
    db,
    terminal,
    executeTakeFirst: mocks.selectExecuteTakeFirst,
    execute: mocks.selectExecute,
    updateSet: mocks.updateSet,
    updateTerminal: { where: mocks.updateWhere, execute: mocks.updateExecute },
    deleteTerminal: { where: mocks.deleteWhere, execute: mocks.deleteExecute },
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe('AgentTokenStore', () => {
  describe('createStatic', () => {
    it('returns a token with kat_ prefix and 68 chars total', async () => {
      const { db } = createMockDb({
        insertedRow: {
          id: 'tok-static-1',
          token_hash: 'h',
          token_prefix: 'kat_00000000',
          labels: null,
          agent_type: 'static',
          created_at: new Date(),
          last_seen_at: null,
          created_by: null,
          revoked_at: null,
          expires_at: null,
        },
      });
      const store = new AgentTokenStore(db as any);

      const result = await store.createStatic({});

      expect(result.token).toHaveLength(68); // 4 (kat_) + 64 (hex)
      expect(result.token.startsWith('kat_')).toBe(true);
      expect(result.token.slice(4)).toMatch(/^[0-9a-f]{64}$/);
      expect(result.id).toBe('tok-static-1');
      expect(db.insertInto).toHaveBeenCalledWith('agent_tokens');
    });

    it('returns unique tokens on consecutive calls', async () => {
      let callCount = 0;
      const { db } = createMockDb();

      // Override to return different IDs each call
      const insertReturningAll = vi.fn().mockImplementation(() => ({
        executeTakeFirstOrThrow: vi.fn().mockResolvedValue({ id: `tok-${++callCount}` }),
      }));
      (db.insertInto as ReturnType<typeof vi.fn>).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returningAll: insertReturningAll,
        }),
      });

      const store = new AgentTokenStore(db as any);
      const r1 = await store.createStatic({});
      const r2 = await store.createStatic({});

      expect(r1.token).not.toBe(r2.token);
      expect(r1.id).not.toBe(r2.id);
    });

    it('stores labels as JSON when provided', async () => {
      const insertValues = vi.fn();
      const { db } = createMockDb();

      // Capture the values passed to insert
      let capturedValues: any;
      (db.insertInto as ReturnType<typeof vi.fn>).mockReturnValue({
        values: vi.fn().mockImplementation((v: any) => {
          capturedValues = v;
          return {
            returningAll: vi.fn().mockReturnValue({
              executeTakeFirstOrThrow: vi.fn().mockResolvedValue({ id: 'tok-labels' }),
            }),
          };
        }),
      });

      const store = new AgentTokenStore(db as any);
      await store.createStatic({ labels: ['linux', 'x64'], createdBy: 'cli:admin' });

      expect(capturedValues.labels).toBe('["linux","x64"]');
      expect(capturedValues.agent_type).toBe('static');
      expect(capturedValues.created_by).toBe('cli:admin');
      expect(capturedValues.expires_at).toBeNull();
    });
  });

  describe('createEphemeral', () => {
    it('returns a token with kat_ prefix', async () => {
      const { db } = createMockDb();
      const store = new AgentTokenStore(db as any);

      const token = await store.createEphemeral('agent-001', ['linux'], 3600000);

      expect(token).toHaveLength(68);
      expect(token.startsWith('kat_')).toBe(true);
    });

    it('stores expires_at based on TTL', async () => {
      let capturedValues: any;
      const { db } = createMockDb();
      (db.insertInto as ReturnType<typeof vi.fn>).mockReturnValue({
        values: vi.fn().mockImplementation((v: any) => {
          capturedValues = v;
          return { execute: vi.fn().mockResolvedValue(undefined) };
        }),
      });

      const now = Date.now();
      const ttlMs = 3600000;
      const store = new AgentTokenStore(db as any);
      await store.createEphemeral('agent-002', ['linux', 'arm64'], ttlMs);

      expect(capturedValues.agent_type).toBe('ephemeral');
      expect(capturedValues.created_by).toBe('agent-002');
      expect(capturedValues.labels).toBe('["linux","arm64"]');
      // expires_at should be approximately now + ttlMs
      const expiresAt = capturedValues.expires_at.getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(now + ttlMs - 1000);
      expect(expiresAt).toBeLessThanOrEqual(now + ttlMs + 1000);
    });
  });

  describe('validate', () => {
    it('returns row (without hash) for valid token', async () => {
      const plaintext = 'kat_' + 'a'.repeat(64);
      const tokenHash = createHash('sha256').update(plaintext).digest('hex');

      const row = {
        id: 'tok-v1',
        token_hash: tokenHash,
        token_prefix: 'kat_aaaaaaaa',
        labels: '["linux"]',
        agent_type: 'static',
        created_at: new Date(),
        last_seen_at: null,
        created_by: 'cli:admin',
        revoked_at: null,
        expires_at: null,
      };

      const { db } = createMockDb({ selectFirstRow: row });
      const store = new AgentTokenStore(db as any);

      const result = await store.validate(plaintext);

      expect(result).not.toBeNull();
      expect(result!.id).toBe('tok-v1');
      expect(result!.agent_type).toBe('static');
      expect(result!.labels).toBe('["linux"]');
      // Should NOT include token_hash
      expect((result as any).token_hash).toBeUndefined();
    });

    it('returns null for invalid token', async () => {
      const { db } = createMockDb({ selectFirstRow: undefined });
      const store = new AgentTokenStore(db as any);

      const result = await store.validate('kat_invalid');

      expect(result).toBeNull();
    });

    it('returns null for revoked token (query filters revoked_at IS NULL)', async () => {
      const { db } = createMockDb({ selectFirstRow: undefined });
      const store = new AgentTokenStore(db as any);

      const result = await store.validate('kat_revoked');

      expect(result).toBeNull();
    });

    it('returns null for expired token (query filters expires_at > now())', async () => {
      const { db } = createMockDb({ selectFirstRow: undefined });
      const store = new AgentTokenStore(db as any);

      const result = await store.validate('kat_expired');

      expect(result).toBeNull();
    });

    it('fires last_seen_at update on successful validation', async () => {
      const plaintext = 'kat_' + 'b'.repeat(64);
      const row = {
        id: 'tok-v2',
        token_hash: createHash('sha256').update(plaintext).digest('hex'),
        token_prefix: 'kat_bbbbbbbb',
        labels: null,
        agent_type: 'ephemeral',
        created_at: new Date(),
        last_seen_at: null,
        created_by: 'scaler:container',
        revoked_at: null,
        expires_at: new Date(Date.now() + 3600000),
      };

      const { db } = createMockDb({ selectFirstRow: row });
      const store = new AgentTokenStore(db as any);

      await store.validate(plaintext);

      // updateTable should have been called for last_seen_at
      expect(db.updateTable).toHaveBeenCalledWith('agent_tokens');
    });
  });

  describe('revoke', () => {
    it('returns true when token is newly revoked', async () => {
      const { db } = createMockDb({ updateResult: { numUpdatedRows: 1n } });
      const store = new AgentTokenStore(db as any);

      const result = await store.revoke('tok-to-revoke');

      expect(result).toBe(true);
      expect(db.updateTable).toHaveBeenCalledWith('agent_tokens');
    });

    it('returns false when token already revoked or not found', async () => {
      const { db } = createMockDb({ updateResult: { numUpdatedRows: 0n } });
      const store = new AgentTokenStore(db as any);

      const result = await store.revoke('tok-already-revoked');

      expect(result).toBe(false);
    });
  });

  describe('list', () => {
    it('returns tokens without hash', async () => {
      const rows = [
        {
          id: 'tok-1',
          token_prefix: 'kat_11111111',
          labels: '["linux"]',
          agent_type: 'static',
          created_at: new Date(),
          last_seen_at: null,
          created_by: 'cli:admin',
          revoked_at: null,
          expires_at: null,
        },
        {
          id: 'tok-2',
          token_prefix: 'kat_22222222',
          labels: '["linux","arm64"]',
          agent_type: 'ephemeral',
          created_at: new Date(),
          last_seen_at: new Date(),
          created_by: 'scaler:fc',
          revoked_at: null,
          expires_at: new Date(Date.now() + 3600000),
        },
      ];

      const { db } = createMockDb({ selectRows: rows });
      const store = new AgentTokenStore(db as any);

      const result = await store.list();

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('tok-1');
      expect(result[1].id).toBe('tok-2');
    });

    it('filters by agent type when specified', async () => {
      const { db, terminal } = createMockDb({ selectRows: [] });
      const store = new AgentTokenStore(db as any);

      await store.list({ agentType: 'static' });

      // Should have called where with agent_type filter (among others)
      expect(db.selectFrom).toHaveBeenCalledWith('agent_tokens');
    });
  });

  describe('cleanupExpired', () => {
    it('returns count of deleted rows', async () => {
      const { db } = createMockDb({
        selectRows: [
          { id: 'tok-1' },
          { id: 'tok-2' },
          { id: 'tok-3' },
          { id: 'tok-4' },
          { id: 'tok-5' },
        ],
        deleteResult: { numDeletedRows: 5n },
      });
      const store = new AgentTokenStore(db as any);

      const count = await store.cleanupExpired();

      expect(count).toBe(5);
      expect(db.deleteFrom).toHaveBeenCalledWith('agent_tokens');
    });

    it('returns 0 (and skips DELETE entirely) when no expired tokens exist', async () => {
      const { db } = createMockDb({
        selectRows: [],
        deleteResult: { numDeletedRows: 0n },
      });
      const store = new AgentTokenStore(db as any);

      const count = await store.cleanupExpired();

      expect(count).toBe(0);
      // No expired rows -> no DELETE issued (avoids a needless round-trip).
      expect(db.deleteFrom).not.toHaveBeenCalled();
    });

    it('invokes onBeforeDelete with expired token IDs before the DELETE', async () => {
      // TTL-expiry kick: the orchestrator passes a callback that
      // calls AgentRegistry.disconnectByTokenId(id) for every expired
      // token, so any in-flight WS that survived the per-token timer
      // (e.g. across a process restart) is still kicked before the DB
      // row is deleted.
      const { db } = createMockDb({
        selectRows: [{ id: 'tok-A' }, { id: 'tok-B' }],
        deleteResult: { numDeletedRows: 2n },
      });
      const store = new AgentTokenStore(db as any);

      const seen: string[][] = [];
      const count = await store.cleanupExpired({
        onBeforeDelete: (ids) => {
          seen.push([...ids]);
        },
      });

      expect(count).toBe(2);
      expect(seen).toEqual([['tok-A', 'tok-B']]);
    });

    it('does NOT invoke onBeforeDelete when no rows are expired', async () => {
      const { db } = createMockDb({
        selectRows: [],
        deleteResult: { numDeletedRows: 0n },
      });
      const store = new AgentTokenStore(db as any);

      const onBeforeDelete = vi.fn();
      await store.cleanupExpired({ onBeforeDelete });

      expect(onBeforeDelete).not.toHaveBeenCalled();
    });

    it('awaits an async onBeforeDelete callback before issuing the DELETE', async () => {
      // The callback is allowed to return a Promise (e.g. fan-out a
      // peer-mesh broadcast before the DB row vanishes). The DELETE
      // must wait for it to settle.
      const { db } = createMockDb({
        selectRows: [{ id: 'tok-A' }],
        deleteResult: { numDeletedRows: 1n },
      });
      const store = new AgentTokenStore(db as any);

      let callbackCompleted = false;
      const beforeDelete = async () => {
        await new Promise((r) => setTimeout(r, 5));
        callbackCompleted = true;
      };

      const count = await store.cleanupExpired({ onBeforeDelete: beforeDelete });

      expect(callbackCompleted).toBe(true);
      expect(count).toBe(1);
    });
  });
});
